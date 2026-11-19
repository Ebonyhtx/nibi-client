import { describe, expect, it } from "vitest";
import {
  CLI_MEMORY_MAX_ALLOCATIONS,
  CLI_MEMORY_MAX_SAMPLES,
  MEMORY_DIAGNOSTICS_DEFAULT_INTERVAL_MS,
  MEMORY_DIAGNOSTIC_DEPTH_LIMIT,
  MEMORY_DIAGNOSTIC_MAX_STRING,
  MEMORY_DIAGNOSTIC_PLACEHOLDER,
  MEMORY_DIAGNOSTICS_DIRECTORY_ENV,
  MEMORY_DIAGNOSTICS_ENV,
  MEMORY_DIAGNOSTICS_INTERVAL_ENV,
  MEMORY_DIAGNOSTICS_MAX_INTERVAL_MS,
  MEMORY_DIAGNOSTICS_MIN_INTERVAL_MS,
  createMemoryDiagnosticsRegistry,
  createMemorySampleWriteGate,
  formatMemorySampleLine,
  memoryUsageToSampleFields,
  resolveMemoryDiagnosticsConfig,
  sanitizeCliMemoryDiagnostic,
  sanitizeMemoryDiagnosticString,
  sanitizeMemoryDiagnosticValue,
  type MemorySample,
} from "../src/memoryDiagnostics.js";

const base: MemorySample = {
  role: "main",
  rssKb: 400_000,
  heapUsedKb: 100_000,
  counters: { "app.windows": 2, "taskBus.leases": 0 },
};

describe("createMemorySampleWriteGate", () => {
  it("MEM-001 首次采样必写", () => {
    const gate = createMemorySampleWriteGate();
    expect(gate.evaluate(base, 0)).toBe("first");
  });

  it("MEM-002 heap 变化不超过 5% 且计数器不变时不写", () => {
    const gate = createMemorySampleWriteGate();
    gate.evaluate(base, 0);
    expect(gate.evaluate({ ...base, heapUsedKb: 104_000 }, 60_000)).toBeNull();
    expect(gate.evaluate({ ...base, heapUsedKb: 96_000 }, 120_000)).toBeNull();
  });

  it("MEM-002b heap 不动但 rss 或 external 变化超过 10% 时写 changed（真机 host RSS 冲到 1.5GB 的场景）", () => {
    const gate = createMemorySampleWriteGate();
    gate.evaluate({ ...base, externalKb: 18_000 }, 0);
    expect(gate.evaluate({ ...base, rssKb: 436_000, externalKb: 18_000 }, 60_000)).toBeNull();
    expect(gate.evaluate({ ...base, rssKb: 1_534_000, externalKb: 18_000 }, 120_000)).toBe("changed");
    expect(gate.evaluate({ ...base, rssKb: 1_534_000, externalKb: 1_328_000 }, 180_000)).toBe(
      "changed",
    );
  });

  it("MEM-003 heap 相对上一次写盘值变化超过 5% 时写 changed，且基线更新为本次值", () => {
    const gate = createMemorySampleWriteGate();
    gate.evaluate(base, 0);
    expect(gate.evaluate({ ...base, heapUsedKb: 106_000 }, 60_000)).toBe("changed");
    // 相对新基线 106000 只涨 3%，不写。
    expect(gate.evaluate({ ...base, heapUsedKb: 109_000 }, 120_000)).toBeNull();
  });

  it("MEM-004 任一计数器变化（含新增/消失的 key）时写 changed", () => {
    const gate = createMemorySampleWriteGate();
    gate.evaluate(base, 0);
    expect(
      gate.evaluate({ ...base, counters: { ...base.counters, "taskBus.leases": 1 } }, 60_000),
    ).toBe("changed");
    expect(gate.evaluate({ ...base, counters: { "app.windows": 2 } }, 120_000)).toBe("changed");
  });

  it("MEM-005 全部不变时每 5 分钟写一次 heartbeat，并重新计时", () => {
    const gate = createMemorySampleWriteGate();
    gate.evaluate(base, 0);
    expect(gate.evaluate(base, 240_000)).toBeNull();
    expect(gate.evaluate(base, 300_000)).toBe("heartbeat");
    expect(gate.evaluate(base, 360_000)).toBeNull();
    expect(gate.evaluate(base, 600_000)).toBe("heartbeat");
  });

  it("renderer 没有 heapUsed 以外的字段时仍按计数器与心跳门控", () => {
    const gate = createMemorySampleWriteGate();
    const sample: MemorySample = { role: "renderer", counters: { "shiki.tokensCache": 1 } };
    expect(gate.evaluate(sample, 0)).toBe("first");
    expect(gate.evaluate(sample, 60_000)).toBeNull();
    expect(gate.evaluate({ ...sample, counters: { "shiki.tokensCache": 2 } }, 120_000)).toBe(
      "changed",
    );
  });
});

describe("formatMemorySampleLine", () => {
  it("固定字段在前、计数器按字典序、全部取整、缺失字段省略", () => {
    const line = formatMemorySampleLine(
      {
        role: "renderer",
        heapUsedKb: 1234.6,
        counters: { "zeta.b": 2, "alpha.a": 1.4, "alpha.nan": Number.NaN },
      },
      "changed",
    );
    expect(line).toBe("[memory] role=renderer reason=changed heapUsedKb=1235 alpha.a=1 zeta.b=2");
  });
});

describe("memoryUsageToSampleFields", () => {
  it("把字节换算成取整 KB，缺失字段省略", () => {
    expect(memoryUsageToSampleFields({ rss: 2048, heapUsed: 1536, heapTotal: 4096 })).toEqual({
      rssKb: 2,
      heapUsedKb: 2,
      heapTotalKb: 4,
    });
  });
});

describe("createMemoryDiagnosticsRegistry", () => {
  it("MEM-006 provider 抛错只跳过自己，键带 provider 前缀，非数值丢弃", () => {
    const registry = createMemoryDiagnosticsRegistry();
    registry.register("ok", () => ({ size: 3, bad: Number.POSITIVE_INFINITY }));
    registry.register("boom", () => {
      throw new Error("read failed");
    });
    expect(registry.collect()).toEqual({ "ok.size": 3 });
  });

  it("dispose 只移除仍属于自己的注册；同名后注册者覆盖前者", () => {
    const registry = createMemoryDiagnosticsRegistry();
    const first = registry.register("x", () => ({ v: 1 }));
    registry.register("x", () => ({ v: 2 }));
    first.dispose();
    expect(registry.collect()).toEqual({ "x.v": 2 });
  });
});

describe("resolveMemoryDiagnosticsConfig", () => {
  it("默认关闭，环境变量未设置时不启用", () => {
    const config = resolveMemoryDiagnosticsConfig({ env: {} });
    expect(config.enabled).toBe(false);
    expect(config.source).toBe("default");
    expect(config.intervalMs).toBe(MEMORY_DIAGNOSTICS_DEFAULT_INTERVAL_MS);
  });

  it("只接受显式真值，拼写错误一律按关闭处理", () => {
    for (const value of ["1", "true", "YES", " on "]) {
      expect(resolveMemoryDiagnosticsConfig({ env: { [MEMORY_DIAGNOSTICS_ENV]: value } })).toMatchObject(
        { enabled: true, source: "env" },
      );
    }
    for (const value of ["0", "false", "off", "enabled", "", "2"]) {
      expect(
        resolveMemoryDiagnosticsConfig({ env: { [MEMORY_DIAGNOSTICS_ENV]: value } }).enabled,
      ).toBe(false);
    }
  });

  it("运行时开关优先于环境变量", () => {
    expect(
      resolveMemoryDiagnosticsConfig({ env: { [MEMORY_DIAGNOSTICS_ENV]: "1" }, enabled: false }),
    ).toMatchObject({ enabled: false, source: "runtime" });
    expect(
      resolveMemoryDiagnosticsConfig({ env: { [MEMORY_DIAGNOSTICS_ENV]: "0" }, enabled: true }),
    ).toMatchObject({ enabled: true, source: "runtime" });
  });

  it("采样周期裁剪到 [5s, 5min]，非法值回落 15s", () => {
    expect(
      resolveMemoryDiagnosticsConfig({ env: { [MEMORY_DIAGNOSTICS_INTERVAL_ENV]: "1" } }).intervalMs,
    ).toBe(MEMORY_DIAGNOSTICS_MIN_INTERVAL_MS);
    expect(
      resolveMemoryDiagnosticsConfig({ env: { [MEMORY_DIAGNOSTICS_INTERVAL_ENV]: "999999" } })
        .intervalMs,
    ).toBe(MEMORY_DIAGNOSTICS_MAX_INTERVAL_MS);
    expect(
      resolveMemoryDiagnosticsConfig({ env: { [MEMORY_DIAGNOSTICS_INTERVAL_ENV]: "abc" } })
        .intervalMs,
    ).toBe(MEMORY_DIAGNOSTICS_DEFAULT_INTERVAL_MS);
    expect(resolveMemoryDiagnosticsConfig({ intervalMs: 30_000 }).intervalMs).toBe(30_000);
    // 目录只覆盖位置，不隐含开启。
    const directoryOnly = resolveMemoryDiagnosticsConfig({
      env: { [MEMORY_DIAGNOSTICS_DIRECTORY_ENV]: "/tmp/nibi-diag" },
    });
    expect(directoryOnly.enabled).toBe(false);
    expect(directoryOnly.directory).toBe("/tmp/nibi-diag");
  });
});

describe("sanitizeMemoryDiagnosticString", () => {
  it("抹掉 URL 凭据但保留主机，便于定位", () => {
    expect(sanitizeMemoryDiagnosticString("https://user:pass@example.com/x")).toBe(
      "https://[redacted]@example.com/x",
    );
  });

  it("抹掉鉴权头、赋值式令牌与常见令牌前缀", () => {
    expect(sanitizeMemoryDiagnosticString("Authorization: Bearer abcdefghijkl")).not.toContain(
      "abcdefghijkl",
    );
    expect(sanitizeMemoryDiagnosticString("token=abc123")).toBe("token=[redacted]");
    expect(sanitizeMemoryDiagnosticString('"api_key": "s3cr3t-value"')).not.toContain("s3cr3t");
    expect(sanitizeMemoryDiagnosticString("sk-abcdefgh12345678")).toBe("[redacted]");
    expect(sanitizeMemoryDiagnosticString("ghp_abcdefgh12345678")).toBe("[redacted]");
  });

  it("把家目录折叠成 ~（POSIX 与 Windows）", () => {
    expect(sanitizeMemoryDiagnosticString("/Users/alice/work/app.ts")).toBe("~/work/app.ts");
    expect(sanitizeMemoryDiagnosticString("/home/bob/work/app.ts")).toBe("~/work/app.ts");
    // String.raw 保住反斜杠，避免测试源文件本身被当成转义序列。
    expect(sanitizeMemoryDiagnosticString(String.raw`C:\Users\alice\AppData\Roaming`)).toBe(
      String.raw`~\AppData\Roaming`,
    );
  });

  it("超长字符串截断，避免单字段撑爆记录", () => {
    const long = "a".repeat(MEMORY_DIAGNOSTIC_MAX_STRING + 10);
    expect(sanitizeMemoryDiagnosticString(long)).toHaveLength(MEMORY_DIAGNOSTIC_MAX_STRING + 1);
  });
});

describe("sanitizeMemoryDiagnosticValue", () => {
  it("递归脱敏嵌套对象与数组，敏感键名整段替换", () => {
    expect(
      sanitizeMemoryDiagnosticValue({
        token: "abc",
        nested: { note: "/home/bob/x", list: [1, "token=x"] },
      }),
    ).toEqual({
      token: "[redacted]",
      nested: { note: "~/x", list: [1, "token=[redacted]"] },
    });
  });

  it("深度超限变成占位符，不继续展开", () => {
    expect(sanitizeMemoryDiagnosticValue({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toEqual({
      a: { b: MEMORY_DIAGNOSTIC_DEPTH_LIMIT },
    });
  });

  it("未知对象（Map/Set/Date/类实例/函数）变成占位符", () => {
    class Custom {
      value = 1;
    }
    const sanitized = sanitizeMemoryDiagnosticValue({
      map: new Map([["a", 1]]),
      set: new Set([1]),
      date: new Date(0),
      custom: new Custom(),
      fn: () => 1,
      big: 1n,
      nan: Number.NaN,
      nil: null,
    }) as Record<string, unknown>;
    for (const key of ["map", "set", "date", "custom", "fn", "big", "nan"]) {
      expect(sanitized[key]).toBe(MEMORY_DIAGNOSTIC_PLACEHOLDER);
    }
    expect(sanitized.nil).toBeNull();
  });

  it("数组长度与键数受上限约束，原型污染键被丢弃", () => {
    const sanitized = sanitizeMemoryDiagnosticValue(
      { list: [1, 2, 3, 4] },
      { maxArrayLength: 2 },
    ) as Record<string, unknown>;
    expect(sanitized.list).toEqual([1, 2]);
    const polluted = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}');
    expect(sanitizeMemoryDiagnosticValue(polluted)).toEqual({ ok: 1 });
  });
});

describe("sanitizeCliMemoryDiagnostic", () => {
  const record = {
    format: "nibi-cli-memory-v1",
    timestamp: 10,
    instanceId: "00000000-0000-4000-8000-000000000000",
    pid: 123,
    version: "3.18.1",
    commit: "abcdef01",
    node: "24.21.0",
    v8: "15.2",
    bundleSha256: "a".repeat(64),
    sampler: {
      state: "active",
      intervalBytes: 1_048_576,
      windowStartedAt: 0,
      profileCapturedAt: 5,
      durationMs: 3,
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
        counters: { sessions: 2, "v4.publishers": 1, bad: "x" },
      },
    ],
    allocations: [
      {
        bytes: 2_097_152,
        stack: [{ name: "grow", line: 5, column: 32 }],
      },
    ],
    counters: { sampledTurns: 3, droppedSamples: 1, fileBytes: 1024, lastError: "" },
  };

  it("白名单投影丢弃未知字段与注入的正文/环境变量", () => {
    const safe = sanitizeCliMemoryDiagnostic({
      ...record,
      prompt: "private prompt",
      environment: { token: "private token" },
      allocations: [
        { bytes: 1, stack: [{ name: "/Users/private/token", line: 1, column: 2 }] },
      ],
    })!;
    expect(JSON.stringify(safe)).not.toContain("private");
    expect(safe.allocations[0]!.stack[0]!.name).toBe("");
    expect(safe.allocations[0]!.stack[0]!.column).toBe(2);
  });

  it("格式不符或采样状态未知时整条记录拒绝", () => {
    expect(sanitizeCliMemoryDiagnostic({ ...record, format: "other" })).toBeNull();
    expect(
      sanitizeCliMemoryDiagnostic({ ...record, sampler: { ...record.sampler, state: "weird" } }),
    ).toBeNull();
    expect(sanitizeCliMemoryDiagnostic("nope")).toBeNull();
  });

  it("读数、热点与计数器数量封顶，非数值丢弃", () => {
    const samples = Array.from({ length: 12 }, (_, index) => ({ ...record.samples[0], at: index }));
    const allocations = Array.from({ length: 40 }, () => record.allocations[0]);
    const safe = sanitizeCliMemoryDiagnostic({ ...record, samples, allocations })!;
    expect(safe.samples).toHaveLength(CLI_MEMORY_MAX_SAMPLES);
    expect(safe.samples.at(-1)!.at).toBe(11);
    expect(safe.allocations).toHaveLength(CLI_MEMORY_MAX_ALLOCATIONS);
    expect(safe.samples[0]!.counters).toEqual({ sessions: 2, "v4.publishers": 1 });
    expect(safe.counters).toEqual(record.counters);
  });
});
