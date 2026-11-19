import { performance } from "node:perf_hooks";
import { normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLI_MEMORY_MAX_ALLOCATIONS,
  CLI_MEMORY_MAX_SAMPLES,
  CLI_MEMORY_MAX_STACK_DEPTH,
  sanitizeCliMemoryDiagnostic,
  type CliMemoryAllocation,
  type CliMemoryDiagnostic,
  type CliMemoryDiagnosticCounters,
  type CliMemoryReading,
} from "@nibi/shared";
import type {
  AllocationNode,
  MemoryDiagnosticOptions,
  MemoryDiagnosticRecorder,
} from "./types.js";

/** 1 MiB 一次分配采样；再密就只是把成本抬上去，分辨率并不会更好。 */
export const MEMORY_SAMPLE_INTERVAL_BYTES = 1024 * 1024;
/** 默认 15s 一轮；实际周期由显式开关解析（见 index.ts），默认关闭。 */
export const MEMORY_DIAGNOSTIC_INTERVAL_MS = 15_000;
/** 每 60s 重置一次 V8 采样窗口，避免 profile 随进程寿命无限增长。 */
export const MEMORY_PROFILE_WINDOW_MS = 60_000;
const MAX_PROFILE_NODES = 4096;
const MAX_PROFILE_WORK_MS = 25;
const MAX_HEAP_USAGE_RATIO = 0.8;

function comparablePath(path: string): string {
  const normalized = normalize(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * 把 V8 分配 profile 投影成有界热点列表。
 *
 * 只保留命中发布 bundle 的栈帧：eval、插件、用户脚本的名字与路径都不能进日志。
 * 节点数超限直接返回 null（本轮永久降级为纯指标），而不是继续复制巨大 children。
 */
function projectAllocations(
  head: AllocationNode,
  bundlePath: string,
): CliMemoryAllocation[] | null {
  const expectedPath = comparablePath(bundlePath);
  const work: Array<{ node: AllocationNode; stack: CliMemoryAllocation["stack"] }> = [
    { node: head, stack: [] },
  ];
  const top: CliMemoryAllocation[] = [];
  let visited = 0;
  while (work.length > 0) {
    visited += 1;
    if (visited > MAX_PROFILE_NODES) return null;
    const current = work.pop()!;
    const frame = current.node.callFrame;
    let path = frame.url;
    if (path.startsWith("file:")) {
      try {
        path = fileURLToPath(path);
      } catch {
        path = "";
      }
    }
    const stack =
      comparablePath(path) === expectedPath
        ? [
            ...current.stack,
            { name: frame.functionName, line: frame.lineNumber, column: frame.columnNumber },
          ].slice(-CLI_MEMORY_MAX_STACK_DEPTH)
        : current.stack;
    if (current.node.selfSize > 0 && stack.length > 0) {
      top.push({ bytes: current.node.selfSize, stack });
      top.sort((a, b) => b.bytes - a.bytes);
      if (top.length > CLI_MEMORY_MAX_ALLOCATIONS) top.pop();
    }
    if (visited + work.length + current.node.children.length > MAX_PROFILE_NODES) return null;
    for (const child of current.node.children) work.push({ node: child, stack });
  }
  return top;
}

export function createMemoryDiagnosticRecorder(
  options: MemoryDiagnosticOptions,
): MemoryDiagnosticRecorder {
  const now = options.now ?? Date.now;
  const measure = options.measure ?? (() => performance.now());
  const counters: CliMemoryDiagnosticCounters = {
    sampledTurns: 0,
    droppedSamples: 0,
    fileBytes: 0,
    lastError: "",
  };
  let stopped = false;
  let busy = false;
  let started = false;
  let disposed = false;
  let state: CliMemoryDiagnostic["sampler"]["state"] = "unsupported";
  let windowStartedAt = 0;
  let profileCapturedAt = 0;
  let profileWindowStartedAt = 0;
  let lastAllocations: CliMemoryAllocation[] = [];
  const samples: CliMemoryReading[] = [];

  const disposeProfiler = () => {
    if (disposed) return;
    disposed = true;
    try {
      options.profiler.dispose();
    } catch {
      // 诊断清理不能影响 runtime 退出。
    }
  };

  return {
    async start() {
      if (started || stopped) return;
      started = true;
      busy = true;
      try {
        const began = measure();
        await options.profiler.start();
        if (stopped) {
          disposeProfiler();
          return;
        }
        state = measure() - began > MAX_PROFILE_WORK_MS ? "budget-exceeded" : "active";
        windowStartedAt = now();
        if (state !== "active") disposeProfiler();
      } catch {
        disposeProfiler();
      } finally {
        busy = false;
      }
    },

    async sample() {
      // 磁盘慢、inspector 忙或正在退出时直接丢本轮，绝不叠加 promise 队列。
      if (stopped || !started) return;
      if (busy) {
        counters.droppedSamples += 1;
        // 慢磁盘不能把采样窗口无限拉长；忙到窗口到期就直接释放 profiler。
        if (state === "active" && now() - windowStartedAt >= MEMORY_PROFILE_WINDOW_MS) {
          state = "budget-exceeded";
          disposeProfiler();
        }
        return;
      }
      busy = true;
      try {
        const began = measure();
        const memory = options.readMemory();
        samples.push({ at: now(), ...memory, counters: options.readCounters() });
        if (samples.length > CLI_MEMORY_MAX_SAMPLES) samples.shift();
        if (
          state === "active" &&
          memory.heapLimit > 0 &&
          memory.heapUsed >= memory.heapLimit * MAX_HEAP_USAGE_RATIO
        ) {
          // 接近堆上限时不再物化 profile：取证本身可能就是最后一次大分配。
          state = "budget-exceeded";
          disposeProfiler();
        }
        if (state === "active") {
          try {
            const profile = await options.profiler.read();
            if (stopped) return;
            const projected = projectAllocations(profile.head, options.bundlePath);
            if (!projected || measure() - began > MAX_PROFILE_WORK_MS) {
              state = "budget-exceeded";
              disposeProfiler();
            } else {
              // 降级后仍带上最后一次有效热点，纯指标轮次不能覆盖关键现场。
              lastAllocations = projected;
              profileCapturedAt = now();
              profileWindowStartedAt = windowStartedAt;
              if (now() - windowStartedAt >= MEMORY_PROFILE_WINDOW_MS) {
                await options.profiler.reset();
                if (stopped) return;
                windowStartedAt = now();
              }
            }
          } catch {
            state = "error";
            disposeProfiler();
          }
        }
        if (stopped) return;
        const durationMs = measure() - began;
        if (state === "active" && durationMs > MAX_PROFILE_WORK_MS) {
          state = "budget-exceeded";
          disposeProfiler();
        }
        // 写盘前再做一次白名单投影：未知字段、路径与源码在这里被丢弃。
        counters.sampledTurns += 1;
        const record = sanitizeCliMemoryDiagnostic({
          format: "nibi-cli-memory-v1",
          timestamp: now(),
          ...options.metadata(),
          sampler: {
            state,
            intervalBytes: MEMORY_SAMPLE_INTERVAL_BYTES,
            windowStartedAt: profileWindowStartedAt,
            profileCapturedAt,
            durationMs,
          },
          samples,
          allocations: lastAllocations,
          counters,
        });
        if (!record) {
          counters.droppedSamples += 1;
          counters.lastError = "sanitize_failed";
          return;
        }
        const result = await options.write(record);
        if (result.ok) {
          counters.fileBytes = result.bytes;
          counters.lastError = "";
        } else {
          counters.droppedSamples += 1;
          counters.lastError = result.error ?? "write_failed";
        }
      } catch {
        // 只丢当前样本；不在 OOM 现场增加错误日志或重试。
        counters.droppedSamples += 1;
        counters.lastError = "sample_failed";
      } finally {
        busy = false;
      }
    },

    stop() {
      stopped = true;
      disposeProfiler();
    },

    getCounters() {
      return { ...counters };
    },
  };
}
