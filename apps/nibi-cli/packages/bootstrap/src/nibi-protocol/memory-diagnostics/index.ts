import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getHeapStatistics } from "node:v8";
import {
  CLI_MEMORY_DIAGNOSTIC_DIRECTORY,
  NIBI_COMMIT,
  NIBI_VERSION,
  resolveMemoryDiagnosticsConfig,
  type CliMemoryDiagnostic,
  type CliMemoryDiagnosticCounters,
  type MemoryDiagnosticsConfig,
} from "@nibi/shared";
import {
  createMemoryDiagnosticRecorder,
  MEMORY_DIAGNOSTIC_INTERVAL_MS,
} from "./recorder.js";
import { writeMemoryDiagnostic } from "./storage.js";
import { createAllocationProfiler } from "./profiler.js";
import type {
  AllocationProfiler,
  MemoryDiagnosticWriteResult,
} from "./types.js";

export { createMemoryDiagnosticRecorder, MEMORY_DIAGNOSTIC_INTERVAL_MS } from "./recorder.js";
export { resolveDiagnosticFilePath, writeMemoryDiagnostic } from "./storage.js";
export type {
  AllocationProfiler,
  MemoryDiagnosticOptions,
  MemoryDiagnosticRecorder,
  MemoryDiagnosticWriteResult,
} from "./types.js";

/** bundle 超过 128 MiB 就不算哈希：诊断不值得为一个大文件多读一遍盘。 */
const MAX_HASH_BYTES = 128 * 1024 * 1024;

export interface CliMemoryDiagnostics {
  /** 本次是否真正开启采样；关闭时所有方法都是 no-op。 */
  readonly enabled: boolean;
  readonly config: MemoryDiagnosticsConfig;
  /** 健康度计数器快照（采样轮次、丢弃轮次、文件字节、最近错误码）。 */
  getCounters(): CliMemoryDiagnosticCounters;
  /** 幂等停止采样；不等待在途写盘，不改变任务生命周期。 */
  stop(): void;
}

interface MemoryDiagnosticsTimerHandle {
  unref?(): void;
}

export interface MemoryDiagnosticsTimer {
  setInterval(callback: () => void, intervalMs: number): MemoryDiagnosticsTimerHandle;
  clearInterval(handle: MemoryDiagnosticsTimerHandle): void;
}

export interface StartCliMemoryDiagnosticsOptions {
  /** 默认 `process.env`；测试可注入。 */
  env?: Record<string, string | undefined>;
  /** 运行时显式开关，优先级高于环境变量。 */
  enabled?: boolean;
  /** 运行时显式采样周期，裁剪到 [5s, 5min]。 */
  intervalMs?: number;
  /** 诊断目录；默认 `<storageRoot>/cli/memory-diagnostics`。 */
  directory?: string;
  /** 发布 bundle 路径；默认 `process.argv[1]`。 */
  bundlePath?: string;
  /** 测试注入的分配采样器；生产走进程内 inspector。 */
  profiler?: AllocationProfiler;
  /** 测试注入的写盘实现。 */
  write?(directory: string, record: CliMemoryDiagnostic): Promise<MemoryDiagnosticWriteResult>;
  timer?: MemoryDiagnosticsTimer;
  now?(): number;
  measure?(): number;
}

const defaultTimer: MemoryDiagnosticsTimer = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

/** 与 adapters 的 `resolveCliRoot` 同一约定：`NIBI_STORAGE_DIR` 覆盖 `~/.nibi`。 */
function resolveDefaultDiagnosticsDirectory(env: Record<string, string | undefined>): string {
  const storageRoot = env.NIBI_STORAGE_DIR?.trim() || join(homedir(), ".nibi");
  return join(storageRoot, "cli", CLI_MEMORY_DIAGNOSTIC_DIRECTORY);
}

function zeroCounters(): CliMemoryDiagnosticCounters {
  return { sampledTurns: 0, droppedSamples: 0, fileBytes: 0, lastError: "" };
}

async function hashBundle(path: string): Promise<string> {
  try {
    if (!path || (await stat(path)).size > MAX_HASH_BYTES) return "";
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(path)) {
      bytes += (chunk as Buffer).length;
      if (bytes > MAX_HASH_BYTES) return "";
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  } catch {
    return "";
  }
}

/**
 * 启动 CLI 分配诊断。
 *
 * 默认关闭：只有 `NIBI_MEMORY_DIAGNOSTICS=1`（或运行时显式 `enabled: true`）才连接
 * inspector 并写盘。关闭时本函数不创建 timer、不连 inspector、不碰文件系统。
 *
 * 开启后：每 `intervalMs`（默认 15s，裁剪到 [5s, 5min]）采样一次，
 * 记录有界（8 个读数 / 32 个热点 / 每栈 8 层），文件有界（见 storage.ts）。
 * 所有失败只影响诊断自身，不向任务抛错。
 */
export function startCliMemoryDiagnostics(
  readCounters: () => Record<string, number>,
  options: StartCliMemoryDiagnosticsOptions = {},
): CliMemoryDiagnostics {
  const env = options.env ?? process.env;
  const config = resolveMemoryDiagnosticsConfig({
    env,
    ...(typeof options.enabled === "boolean" ? { enabled: options.enabled } : {}),
    ...(typeof options.intervalMs === "number" ? { intervalMs: options.intervalMs } : {}),
    ...(options.directory ? { directory: options.directory } : {}),
  });
  if (!config.enabled) {
    return {
      enabled: false,
      config,
      getCounters: zeroCounters,
      stop() {},
    };
  }

  const directory = config.directory ?? resolveDefaultDiagnosticsDirectory(env);
  const bundlePath = resolve(options.bundlePath ?? process.argv[1] ?? "");
  const metadata: Pick<
    CliMemoryDiagnostic,
    "instanceId" | "pid" | "version" | "commit" | "node" | "v8" | "bundleSha256"
  > = {
    instanceId: randomUUID(),
    pid: process.pid,
    version: NIBI_VERSION,
    commit: NIBI_COMMIT,
    node: process.versions.node,
    v8: process.versions.v8,
    bundleSha256: "",
  };

  let resolvedBundlePath = bundlePath;
  let profiler: AllocationProfiler;
  try {
    profiler = options.profiler ?? createAllocationProfiler();
  } catch {
    // inspector 不可用时退回关闭态；enabled 与实际行为保持一致。
    return {
      enabled: false,
      config: { ...config, enabled: false },
      getCounters: zeroCounters,
      stop() {},
    };
  }
  const write = options.write ?? writeMemoryDiagnostic;
  const recorder = createMemoryDiagnosticRecorder({
    get bundlePath() {
      return resolvedBundlePath;
    },
    metadata: () => metadata,
    readCounters,
    profiler,
    readMemory: () => ({
      ...process.memoryUsage(),
      heapLimit: getHeapStatistics().heap_size_limit,
    }),
    write: (record) => write(directory, record),
    ...(options.now ? { now: options.now } : {}),
    ...(options.measure ? { measure: options.measure } : {}),
  });

  // 哈希流式读取，不复制 bundle 到 JS 堆，也不挡住协议 ready。
  // macOS 的 /var、/tmp 别名与 V8 返回的真实路径不同，需异步归一化后再匹配采样帧。
  void realpath(bundlePath).then(
    (path) => {
      resolvedBundlePath = path;
    },
    () => {},
  );
  void hashBundle(bundlePath).then(
    (hash) => {
      metadata.bundleSha256 = hash;
    },
    () => {},
  );
  void recorder.start();

  const timer = options.timer ?? defaultTimer;
  let handle: MemoryDiagnosticsTimerHandle | undefined;
  try {
    handle = timer.setInterval(() => {
      void recorder.sample();
    }, config.intervalMs);
  } catch {
    // 定时器不可用时立刻停止采样，避免 inspector 会话悬空。
    recorder.stop();
    handle = undefined;
  }
  if (handle) {
    try {
      handle.unref?.();
    } catch {
      // unref 不可用时仍保留 handle，确保 stop 能回收定时器。
    }
  }

  return {
    enabled: true,
    config,
    getCounters: () => recorder.getCounters(),
    stop() {
      if (handle) {
        const current = handle;
        handle = undefined;
        try {
          timer.clearInterval(current);
        } catch {
          // 清理失败不能阻塞 CLI 退出。
        }
      }
      recorder.stop();
    },
  };
}
