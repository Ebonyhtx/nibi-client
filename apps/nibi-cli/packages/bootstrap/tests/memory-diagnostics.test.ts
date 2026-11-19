import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLI_MEMORY_DIAGNOSTIC_FORMAT,
  CLI_MEMORY_MAX_FILE_BYTES,
  CLI_MEMORY_MAX_FILES,
  type CliMemoryDiagnostic,
} from "@nibi/shared";
import {
  resolveDiagnosticFilePath,
  startCliMemoryDiagnostics,
  writeMemoryDiagnostic,
} from "../src/nibi-protocol/memory-diagnostics/index.js";
import { createMemoryDiagnosticRecorder } from "../src/nibi-protocol/memory-diagnostics/recorder.js";
import type {
  AllocationNode,
  AllocationProfiler,
  MemoryDiagnosticWriteResult,
} from "../src/nibi-protocol/memory-diagnostics/types.js";

const directories: string[] = [];
const metadata = {
  instanceId: "00000000-0000-4000-8000-000000000000",
  pid: 123,
  version: "0.1.0",
  commit: "abcdef01",
  node: "24.21.0",
  v8: "15.2",
  bundleSha256: "a".repeat(64),
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "nibi-memory-diag-"));
  directories.push(directory);
  return directory;
}

function profileFor(bundlePath: string): { head: AllocationNode } {
  return {
    head: {
      id: 1,
      selfSize: 0,
      callFrame: { functionName: "", url: "", lineNumber: 0, columnNumber: 0 },
      children: [
        {
          id: 2,
          selfSize: 2_097_152,
          callFrame: { functionName: "grow", url: bundlePath, lineNumber: 5, columnNumber: 32 },
          children: [],
        },
      ],
    },
  };
}

function fakeProfiler(bundlePath: string): AllocationProfiler {
  return {
    start: vi.fn(async () => {}),
    read: vi.fn(async () => profileFor(bundlePath)),
    reset: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
}

function record(overrides: Partial<CliMemoryDiagnostic> = {}): CliMemoryDiagnostic {
  return {
    format: CLI_MEMORY_DIAGNOSTIC_FORMAT,
    timestamp: 1,
    ...metadata,
    sampler: {
      state: "active",
      intervalBytes: 1_048_576,
      windowStartedAt: 0,
      profileCapturedAt: 1,
      durationMs: 1,
    },
    samples: [
      {
        at: 1,
        rss: 100,
        heapUsed: 50,
        heapTotal: 80,
        external: 20,
        arrayBuffers: 10,
        heapLimit: 200,
        counters: { sessions: 2 },
      },
    ],
    allocations: [],
    counters: { sampledTurns: 1, droppedSamples: 0, fileBytes: 0, lastError: "" },
    ...overrides,
  };
}

describe("CLI memory diagnostics switch", () => {
  it("默认关闭：不创建目录、不连 inspector、计数器全零", async () => {
    const directory = await tempDirectory();
    const profiler = fakeProfiler("bundle.cjs");
    const diagnostics = startCliMemoryDiagnostics(() => ({ sessions: 1 }), {
      env: {},
      directory,
      profiler,
    });
    expect(diagnostics.enabled).toBe(false);
    expect(diagnostics.config.source).toBe("default");
    expect(diagnostics.getCounters()).toEqual({
      sampledTurns: 0,
      droppedSamples: 0,
      fileBytes: 0,
      lastError: "",
    });
    expect(profiler.start).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
    diagnostics.stop();
  });

  it("显式 NIBI_MEMORY_DIAGNOSTICS=1 才开启，并采用裁剪后的周期", () => {
    const diagnostics = startCliMemoryDiagnostics(() => ({}), {
      env: { NIBI_MEMORY_DIAGNOSTICS: "1", NIBI_MEMORY_DIAGNOSTICS_INTERVAL_MS: "1" },
      directory: join(tmpdir(), "nibi-diag-unused"),
      profiler: fakeProfiler("bundle.cjs"),
      timer: { setInterval: () => ({ unref() {} }), clearInterval: () => {} },
      bundlePath: "bundle.cjs",
    });
    expect(diagnostics.enabled).toBe(true);
    expect(diagnostics.config.source).toBe("env");
    expect(diagnostics.config.intervalMs).toBe(5_000);
    diagnostics.stop();
  });
});

describe("enabled sampling", () => {
  it("按周期采样并写出不超过上限的记录文件，stop 后不再写", async () => {
    const directory = await tempDirectory();
    const bundlePath = join(directory, "nibi.cjs");
    const profiler = fakeProfiler(bundlePath);
    let tick: (() => void) | undefined;
    const timer = {
      setInterval: (callback: () => void) => {
        tick = callback;
        return { unref() {} };
      },
      clearInterval: () => {
        tick = undefined;
      },
    };
    const diagnostics = startCliMemoryDiagnostics(() => ({ sessions: 2 }), {
      env: { NIBI_MEMORY_DIAGNOSTICS: "1" },
      directory,
      bundlePath,
      profiler,
      timer,
    });
    expect(diagnostics.enabled).toBe(true);
    expect(tick).toBeDefined();

    // recorder.start() 在首个微任务里完成 inspector 连接；先让出一次再触发采样。
    await new Promise((resolve) => setTimeout(resolve, 0));
    tick?.();
    await vi.waitFor(async () => {
      const files = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
      expect(files).toHaveLength(1);
    });

    const files = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
    const path = join(directory, files[0]!);
    const info = await stat(path);
    expect(info.size).toBeLessThanOrEqual(CLI_MEMORY_MAX_FILE_BYTES);
    const parsed = JSON.parse(await readFile(path, "utf8")) as CliMemoryDiagnostic;
    expect(parsed.format).toBe(CLI_MEMORY_DIAGNOSTIC_FORMAT);
    expect(parsed.samples).toHaveLength(1);
    expect(parsed.allocations[0]?.stack[0]?.name).toBe("grow");
    // 记录里不能出现 bundle 的绝对路径。
    expect(await readFile(path, "utf8")).not.toContain(directory);
    expect(diagnostics.getCounters().sampledTurns).toBe(1);
    expect(diagnostics.getCounters().fileBytes).toBeGreaterThan(0);
    expect(diagnostics.getCounters().lastError).toBe("");

    diagnostics.stop();
    expect(tick).toBeUndefined();
    expect(profiler.dispose).toHaveBeenCalledTimes(1);
    expect(diagnostics.getCounters().sampledTurns).toBe(1);
  });

  it("写入前做白名单投影：注入的路径与令牌不会落到文件", async () => {
    const directory = await tempDirectory();
    const result = await writeMemoryDiagnostic(
      directory,
      record({ version: "/Users/alice/token=abc", commit: "x".repeat(120) }),
    );
    expect(result.ok).toBe(true);
    const files = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const text = await readFile(join(directory, files[0]!), "utf8");
    expect(text).not.toContain("/Users/");
    expect(text).not.toContain("token=");
    expect((JSON.parse(text) as CliMemoryDiagnostic).version).toBe("");
    expect((JSON.parse(text) as CliMemoryDiagnostic).commit).toBe("");
  });
});

describe("bounded rotation", () => {
  it("跨实例反复写入后文件数不超过 16、单文件不超过 64KiB、无残留临时文件", async () => {
    const directory = await tempDirectory();
    for (let index = 0; index < 24; index += 1) {
      const instanceId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const result = await writeMemoryDiagnostic(directory, {
        ...record({ timestamp: Date.now() + index }),
        instanceId,
      });
      expect(result.ok).toBe(true);
    }
    const names = await readdir(directory);
    const files = names.filter((name) => name.endsWith(".jsonl"));
    expect(files).toHaveLength(CLI_MEMORY_MAX_FILES);
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
    for (const name of files) {
      expect((await stat(join(directory, name))).size).toBeLessThanOrEqual(
        CLI_MEMORY_MAX_FILE_BYTES,
      );
    }
    // 同一实例重复写只保留最近 2 个完成文件。
    for (let index = 0; index < 5; index += 1) {
      await writeMemoryDiagnostic(directory, record({ timestamp: Date.now() + index }));
    }
    const finalNames = await readdir(directory);
    expect(
      finalNames.filter((name) => name.endsWith(`-${metadata.instanceId}.jsonl`)),
    ).toHaveLength(2);
    expect(finalNames.filter((name) => name.endsWith(".jsonl")).length).toBeLessThanOrEqual(
      CLI_MEMORY_MAX_FILES,
    );
  });

  it("拒绝诊断目录之外的目标路径与非法文件名", async () => {
    const directory = await tempDirectory();
    expect(resolveDiagnosticFilePath(directory, "../escape.jsonl")).toBeNull();
    expect(resolveDiagnosticFilePath(directory, "records.jsonl")).toBeNull();
    expect(resolveDiagnosticFilePath(directory, "C:\\temp\\memory-1-x.jsonl")).toBeNull();
    const valid = resolveDiagnosticFilePath(
      directory,
      `memory-1-${metadata.instanceId}.jsonl`,
    );
    expect(valid).not.toBeNull();
    expect(valid!.startsWith(directory)).toBe(true);
  });
});

describe("failure isolation and counters", () => {
  it("写盘抛错只丢本轮，不向调用方抛异常", async () => {
    const recorder = createMemoryDiagnosticRecorder({
      bundlePath: "bundle.cjs",
      metadata: () => metadata,
      profiler: fakeProfiler("bundle.cjs"),
      readMemory: () => ({
        rss: 100,
        heapUsed: 50,
        heapTotal: 80,
        external: 20,
        arrayBuffers: 10,
        heapLimit: 200,
      }),
      readCounters: () => ({ sessions: 1 }),
      write: async () => {
        throw new Error("disk full");
      },
    });
    await recorder.start();
    await expect(recorder.sample()).resolves.toBeUndefined();
    expect(recorder.getCounters()).toMatchObject({
      sampledTurns: 1,
      droppedSamples: 1,
      lastError: "sample_failed",
    });
    recorder.stop();
  });

  it("存储层返回错误码时计数为 droppedSamples/lastError，成功时重置", async () => {
    const results: MemoryDiagnosticWriteResult[] = [
      { ok: false, bytes: 0, error: "write_failed" },
      { ok: true, bytes: 4096 },
    ];
    const recorder = createMemoryDiagnosticRecorder({
      bundlePath: "bundle.cjs",
      metadata: () => metadata,
      profiler: fakeProfiler("bundle.cjs"),
      readMemory: () => ({
        rss: 100,
        heapUsed: 50,
        heapTotal: 80,
        external: 20,
        arrayBuffers: 10,
        heapLimit: 200,
      }),
      readCounters: () => ({ sessions: 1 }),
      write: async () => results.shift() ?? { ok: true, bytes: 0 },
    });
    await recorder.start();
    await recorder.sample();
    expect(recorder.getCounters()).toMatchObject({
      sampledTurns: 1,
      droppedSamples: 1,
      lastError: "write_failed",
    });
    await recorder.sample();
    expect(recorder.getCounters()).toMatchObject({
      sampledTurns: 2,
      droppedSamples: 1,
      fileBytes: 4096,
      lastError: "",
    });
    recorder.stop();
  });

  it("在途采样期间到达的轮次计入 droppedSamples 且不排队", async () => {
    let finish: (() => void) | undefined;
    const recorder = createMemoryDiagnosticRecorder({
      bundlePath: "bundle.cjs",
      metadata: () => metadata,
      profiler: fakeProfiler("bundle.cjs"),
      readMemory: () => ({
        rss: 100,
        heapUsed: 50,
        heapTotal: 80,
        external: 20,
        arrayBuffers: 10,
        heapLimit: 200,
      }),
      readCounters: () => ({ sessions: 1 }),
      write: () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true, bytes: 128 });
        }),
    });
    await recorder.start();
    const pending = recorder.sample();
    await Promise.resolve();
    await recorder.sample();
    expect(recorder.getCounters().droppedSamples).toBe(1);
    await vi.waitFor(() => expect(finish).toBeDefined());
    finish?.();
    await pending;
    expect(recorder.getCounters()).toMatchObject({ sampledTurns: 1, fileBytes: 128 });
    recorder.stop();
  });
});
