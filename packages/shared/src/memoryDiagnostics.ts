/**
 * 进程内存本地诊断日志的共用纯逻辑。
 *
 * main / renderer / host / agent CLI 四类进程各自采样，但写盘门控、行格式和计数器注册表
 * 只有这一份实现，避免四处各写一套阈值。本文件不依赖 Node / DOM API。
 */

export type MemorySampleRole = "main" | "renderer" | "utility_host" | "agent_node";

export type MemorySampleWriteReason = "first" | "changed" | "heartbeat";

export interface MemorySampleFields {
  rssKb?: number;
  heapUsedKb?: number;
  heapTotalKb?: number;
  externalKb?: number;
  arrayBuffersKb?: number;
}

export interface MemorySample extends MemorySampleFields {
  role: MemorySampleRole;
  /** `<provider>.<key>` → 数值；只允许纯读取得到的计数。 */
  counters: Record<string, number>;
}

export interface MemorySampleWriteGateOptions {
  /** heapUsedKb 相对上一次写盘值的变化比例阈值，默认 5%。 */
  heapDeltaRatio?: number;
  /**
   * rssKb / externalKb 相对上一次写盘值的变化比例阈值，默认 10%。
   * 真机上 host 进程 RSS 从 240MB 冲到 1.5GB、externalKb 冲到 1.3GB，而 heapUsed 几乎不动，
   * 只看 heap 的门控把这一分钟判成 heartbeat 静默丢掉；native / external 内存必须单独参与判定。
   */
  nativeDeltaRatio?: number;
  /** 无变化时的心跳间隔，默认 5 分钟。 */
  heartbeatMs?: number;
}

export interface MemorySampleWriteGate {
  /**
   * 判定本次样本是否写盘。返回非 null 时表示应写盘，并把该样本记为“上一次写盘值”。
   */
  evaluate(sample: MemorySample, nowMs: number): MemorySampleWriteReason | null;
}

export const MEMORY_SAMPLE_INTERVAL_MS = 60_000;
export const MEMORY_SAMPLE_HEAP_DELTA_RATIO = 0.05;
export const MEMORY_SAMPLE_NATIVE_DELTA_RATIO = 0.1;
export const MEMORY_SAMPLE_HEARTBEAT_MS = 300_000;

const MEMORY_FIELD_ORDER: readonly (keyof MemorySampleFields)[] = [
  "rssKb",
  "heapUsedKb",
  "heapTotalKb",
  "externalKb",
  "arrayBuffersKb",
];

function countersDiffer(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (a[key] !== b[key]) {
      return true;
    }
  }
  return false;
}

function exceedsRatio(
  current: number | undefined,
  previous: number | undefined,
  ratio: number,
): boolean {
  return (
    current !== undefined &&
    previous !== undefined &&
    Math.abs(current - previous) > Math.max(previous, 1) * ratio
  );
}

export function createMemorySampleWriteGate(
  options: MemorySampleWriteGateOptions = {},
): MemorySampleWriteGate {
  const heapDeltaRatio = options.heapDeltaRatio ?? MEMORY_SAMPLE_HEAP_DELTA_RATIO;
  const nativeDeltaRatio = options.nativeDeltaRatio ?? MEMORY_SAMPLE_NATIVE_DELTA_RATIO;
  const heartbeatMs = options.heartbeatMs ?? MEMORY_SAMPLE_HEARTBEAT_MS;
  let lastWritten: MemorySample | undefined;
  let lastWrittenAt = 0;

  return {
    evaluate(sample, nowMs) {
      let reason: MemorySampleWriteReason | null = null;
      if (!lastWritten) {
        reason = "first";
      } else if (
        exceedsRatio(sample.heapUsedKb, lastWritten.heapUsedKb, heapDeltaRatio) ||
        exceedsRatio(sample.rssKb, lastWritten.rssKb, nativeDeltaRatio) ||
        exceedsRatio(sample.externalKb, lastWritten.externalKb, nativeDeltaRatio)
      ) {
        reason = "changed";
      } else if (countersDiffer(sample.counters, lastWritten.counters)) {
        reason = "changed";
      } else if (nowMs - lastWrittenAt >= heartbeatMs) {
        reason = "heartbeat";
      }
      if (reason) {
        lastWritten = { ...sample, counters: { ...sample.counters } };
        lastWrittenAt = nowMs;
      }
      return reason;
    },
  };
}

export function bytesToKb(bytes: number): number {
  return Math.round(bytes / 1024);
}

/** 把 Node `process.memoryUsage()` 的结果换算成 KB 字段；字段缺失时省略。 */
export function memoryUsageToSampleFields(usage: {
  rss?: number;
  heapUsed?: number;
  heapTotal?: number;
  external?: number;
  arrayBuffers?: number;
}): MemorySampleFields {
  const fields: MemorySampleFields = {};
  if (typeof usage.rss === "number") fields.rssKb = bytesToKb(usage.rss);
  if (typeof usage.heapUsed === "number") fields.heapUsedKb = bytesToKb(usage.heapUsed);
  if (typeof usage.heapTotal === "number") fields.heapTotalKb = bytesToKb(usage.heapTotal);
  if (typeof usage.external === "number") fields.externalKb = bytesToKb(usage.external);
  if (typeof usage.arrayBuffers === "number") {
    fields.arrayBuffersKb = bytesToKb(usage.arrayBuffers);
  }
  return fields;
}

/**
 * 单行 `key=value` 格式：固定内存字段在前，计数器按字典序在后，全部取整。
 * 例：`[memory] role=main reason=first rssKb=1 heapUsedKb=2 app.windows=1`
 */
export function formatMemorySampleLine(
  sample: MemorySample,
  reason: MemorySampleWriteReason,
): string {
  const parts = [`[memory]`, `role=${sample.role}`, `reason=${reason}`];
  for (const field of MEMORY_FIELD_ORDER) {
    const value = sample[field];
    if (typeof value === "number" && Number.isFinite(value)) {
      parts.push(`${field}=${Math.round(value)}`);
    }
  }
  for (const key of Object.keys(sample.counters).sort()) {
    const value = sample.counters[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      parts.push(`${key}=${Math.round(value)}`);
    }
  }
  return parts.join(" ");
}

export type MemoryDiagnosticsProvider = () => Record<string, number>;

export interface MemoryDiagnosticsRegistry {
  /** 同名重复注册时后者覆盖前者；返回的 dispose 只在仍是自己时才移除。 */
  register(name: string, provider: MemoryDiagnosticsProvider): { dispose(): void };
  /** 逐个调用 provider，键以 `<name>.` 为前缀；单个 provider 抛错只跳过它自己。 */
  collect(): Record<string, number>;
}

export function createMemoryDiagnosticsRegistry(): MemoryDiagnosticsRegistry {
  const providers = new Map<string, MemoryDiagnosticsProvider>();
  return {
    register(name, provider) {
      providers.set(name, provider);
      return {
        dispose() {
          if (providers.get(name) === provider) {
            providers.delete(name);
          }
        },
      };
    },
    collect() {
      const result: Record<string, number> = {};
      for (const [name, provider] of providers) {
        try {
          for (const [key, value] of Object.entries(provider())) {
            if (typeof value === "number" && Number.isFinite(value)) {
              result[`${name}.${key}`] = value;
            }
          }
        } catch {
          // 诊断 provider 只做纯读取；任一 provider 异常不能影响其他计数器或业务。
        }
      }
      return result;
    },
  };
}

/* ------------------------------------------------------------------------- *
 * CLI 内存诊断记录：显式开关、有界文件、结构化脱敏
 *
 * 60s 的 `[memory]` 行只回答「哪个进程在涨」；本段描述的是按需开启的分配诊断
 * 记录（默认关闭）：把内存增长关联到发布 bundle 里的代码位置。
 * 这里只放不依赖 Node / DOM 的纯逻辑：配置解析、递归脱敏、记录投影与常量。
 * 文件写入、inspector 采样与轮转在 bootstrap 的 memory-diagnostics 模块。
 * ------------------------------------------------------------------------- */

/** 诊断目录名（位于 CLI 存储根之下：`<storageRoot>/cli/memory-diagnostics`）。 */
export const CLI_MEMORY_DIAGNOSTIC_DIRECTORY = "memory-diagnostics";
export const CLI_MEMORY_DIAGNOSTIC_FORMAT = "nibi-cli-memory-v1";

/**
 * 文件预算：每个进程实例最多 2 个完成文件，全目录最多 16 个，每个 64 KiB，
 * 合计不超过 1 MiB；超过 7 天的文件一并淘汰。
 * JSONL 是覆盖写而不是追加，因此总量不随运行时长或重启次数增长。
 */
export const CLI_MEMORY_MAX_FILES = 16;
export const CLI_MEMORY_MAX_FILE_BYTES = 64 * 1024;
export const CLI_MEMORY_MAX_TOTAL_BYTES = 1024 * 1024;
export const CLI_MEMORY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** 单条记录内的上限：最近 8 个读数、32 个热点、每个热点最后 8 层栈。 */
export const CLI_MEMORY_MAX_SAMPLES = 8;
export const CLI_MEMORY_MAX_ALLOCATIONS = 32;
export const CLI_MEMORY_MAX_STACK_DEPTH = 8;
export const CLI_MEMORY_MAX_COUNTER_KEYS = 32;
export const CLI_MEMORY_FILE_PATTERN = /^memory-[0-9]+-[a-f0-9-]{36}\.jsonl$/;

/** 开关与采样周期（默认关闭）。 */
export const MEMORY_DIAGNOSTICS_ENV = "NIBI_MEMORY_DIAGNOSTICS";
export const MEMORY_DIAGNOSTICS_INTERVAL_ENV = "NIBI_MEMORY_DIAGNOSTICS_INTERVAL_MS";
export const MEMORY_DIAGNOSTICS_DIRECTORY_ENV = "NIBI_MEMORY_DIAGNOSTICS_DIR";
export const MEMORY_DIAGNOSTICS_DEFAULT_INTERVAL_MS = 15_000;
/** 下限 5s：再密就是拿 CPU 换分辨率；上限 5min：再疏就接不上 60s 资源节拍。 */
export const MEMORY_DIAGNOSTICS_MIN_INTERVAL_MS = 5_000;
export const MEMORY_DIAGNOSTICS_MAX_INTERVAL_MS = 300_000;

/** 脱敏预算：递归深度、键数、数组长度、单字符串长度。 */
export const MEMORY_DIAGNOSTIC_MAX_DEPTH = 4;
export const MEMORY_DIAGNOSTIC_MAX_KEYS = 64;
export const MEMORY_DIAGNOSTIC_MAX_ARRAY = 64;
export const MEMORY_DIAGNOSTIC_MAX_STRING = 512;
export const MEMORY_DIAGNOSTIC_REDACTED = "[redacted]";
export const MEMORY_DIAGNOSTIC_PLACEHOLDER = "[placeholder]";
export const MEMORY_DIAGNOSTIC_DEPTH_LIMIT = "[depth-limit]";

export interface CliMemoryReading {
  at: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  heapLimit: number;
  counters: Record<string, number>;
}

export interface CliMemoryAllocation {
  bytes: number;
  stack: Array<{ name: string; line: number; column: number }>;
}

/**
 * 诊断自身的健康度计数器。只含数字与一个短错误码，
 * 供测试与日志读取，不携带任何记录内容。
 */
export interface CliMemoryDiagnosticCounters {
  /** 已完成的采样轮次（每轮最多产出一条记录）。 */
  sampledTurns: number;
  /** 因在途采样/写盘、预算降级或写盘失败而丢弃的轮次。 */
  droppedSamples: number;
  /** 最近一次成功写盘后诊断目录内完成文件的总字节数。 */
  fileBytes: number;
  /** 最近一次失败的错误码（如 `write_failed`），成功时为空串。 */
  lastError: string;
}

export interface CliMemoryDiagnostic {
  format: typeof CLI_MEMORY_DIAGNOSTIC_FORMAT;
  timestamp: number;
  instanceId: string;
  pid: number;
  version: string;
  commit: string;
  node: string;
  v8: string;
  bundleSha256: string;
  sampler: {
    state: "active" | "unsupported" | "budget-exceeded" | "error";
    intervalBytes: number;
    windowStartedAt: number;
    profileCapturedAt: number;
    durationMs: number;
  };
  samples: CliMemoryReading[];
  allocations: CliMemoryAllocation[];
  counters: CliMemoryDiagnosticCounters;
}

export type MemoryDiagnosticsSource = "runtime" | "env" | "default";

export interface MemoryDiagnosticsConfig {
  enabled: boolean;
  /** 已裁剪到 [MIN, MAX] 的采样周期；即使关闭也返回有效值。 */
  intervalMs: number;
  /** 未显式配置时省略，由调用方给出默认目录。 */
  directory?: string;
  /** 本次判定来自运行时参数、环境变量还是默认值，便于日志与测试断言。 */
  source: MemoryDiagnosticsSource;
}

export interface MemoryDiagnosticsConfigInput {
  env?: Record<string, string | undefined>;
  /** 运行时显式配置，优先级高于环境变量。 */
  enabled?: boolean;
  intervalMs?: number;
  directory?: string;
}

const MEMORY_DIAGNOSTICS_TRUTHY = new Set(["1", "true", "yes", "on"]);
const MEMORY_DIAGNOSTICS_FALSY = new Set(["0", "false", "no", "off"]);

function clampMemoryDiagnosticsInterval(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return MEMORY_DIAGNOSTICS_DEFAULT_INTERVAL_MS;
  }
  return Math.min(
    MEMORY_DIAGNOSTICS_MAX_INTERVAL_MS,
    Math.max(MEMORY_DIAGNOSTICS_MIN_INTERVAL_MS, Math.round(value)),
  );
}

/**
 * 解析开关，优先级：运行时参数 > 环境变量 > 默认关闭。
 *
 * - `NIBI_MEMORY_DIAGNOSTICS` 只接受 `1/true/yes/on` 与 `0/false/no/off`；
 *   其他值（含空串、拼写错误）一律按关闭处理，绝不因为"看起来像开启"就打开采样。
 * - `NIBI_MEMORY_DIAGNOSTICS_INTERVAL_MS` 是采样周期，裁剪到 [5s, 5min]，非法值回落 15s。
 * - `NIBI_MEMORY_DIAGNOSTICS_DIR` 只覆盖目录，不隐含开启。
 */
export function resolveMemoryDiagnosticsConfig(
  input: MemoryDiagnosticsConfigInput = {},
): MemoryDiagnosticsConfig {
  const env = input.env ?? {};
  let enabled: boolean;
  let source: MemoryDiagnosticsSource;
  if (typeof input.enabled === "boolean") {
    enabled = input.enabled;
    source = "runtime";
  } else {
    const raw = env[MEMORY_DIAGNOSTICS_ENV]?.trim().toLowerCase();
    if (raw && MEMORY_DIAGNOSTICS_TRUTHY.has(raw)) {
      enabled = true;
      source = "env";
    } else if (raw && MEMORY_DIAGNOSTICS_FALSY.has(raw)) {
      enabled = false;
      source = "env";
    } else {
      enabled = false;
      source = "default";
    }
  }
  const rawInterval = env[MEMORY_DIAGNOSTICS_INTERVAL_ENV]?.trim();
  const intervalMs = clampMemoryDiagnosticsInterval(
    input.intervalMs ?? (rawInterval ? Number(rawInterval) : undefined),
  );
  const directory =
    input.directory?.trim() || env[MEMORY_DIAGNOSTICS_DIRECTORY_ENV]?.trim() || undefined;
  return {
    enabled,
    intervalMs,
    source,
    ...(directory ? { directory } : {}),
  };
}

/** 键名命中即整段替换，避免 `{ token: {...} }` 这类结构被递归展开。 */
const MEMORY_DIAGNOSTIC_SECRET_KEY_PATTERN =
  /(?:^|[._-])(?:tokens?|secrets?|passw(?:or)?ds?|authorization|auth|cookies?|api[_-]?keys?|access[_-]?keys?|private[_-]?keys?|credentials?|session[_-]?keys?)(?:$|[._-])/i;

/** `https://user:pass@host/x` → `https://[redacted]@host/x`（只抹凭据，保留主机用于定位）。 */
const MEMORY_DIAGNOSTIC_URL_CREDENTIALS_PATTERN =
  /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;
/** `Authorization: Bearer abc...` / `Basic abc...`。 */
const MEMORY_DIAGNOSTIC_AUTH_SCHEME_PATTERN =
  /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** `token=...` / `"api_key": "..."` / `password: ...`。 */
const MEMORY_DIAGNOSTIC_ASSIGNMENT_PATTERN =
  /\b(tokens?|secrets?|passw(?:or)?ds?|api[_-]?keys?|access[_-]?keys?|authorization|credentials?)\b(\s*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;"']+)/gi;
/** 常见令牌前缀（即使没有键名也认得出）。 */
const MEMORY_DIAGNOSTIC_TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{12,})\b/g;
/** `/Users/<name>`、`/home/<name>`、`C:\Users\<name>` 一律折叠成 `~`。 */
const MEMORY_DIAGNOSTIC_HOME_PATH_PATTERN =
  /(?:[A-Za-z]:\\Users\\[^\\\s"'`]+|\/(?:Users|home)\/[^/\s"'`]+)/g;

/**
 * 单值脱敏：URL 凭据 → `[redacted]@`，鉴权头/赋值/常见令牌 → `[redacted]`，
 * 家目录 → `~`，超长截断。纯函数，幂等（重复调用结果不变）。
 */
export function sanitizeMemoryDiagnosticString(value: string): string {
  const bounded =
    value.length > MEMORY_DIAGNOSTIC_MAX_STRING
      ? `${value.slice(0, MEMORY_DIAGNOSTIC_MAX_STRING)}…`
      : value;
  return bounded
    .replace(MEMORY_DIAGNOSTIC_URL_CREDENTIALS_PATTERN, "$1[redacted]@")
    .replace(MEMORY_DIAGNOSTIC_AUTH_SCHEME_PATTERN, "$1 [redacted]")
    .replace(MEMORY_DIAGNOSTIC_ASSIGNMENT_PATTERN, "$1$2[redacted]")
    .replace(MEMORY_DIAGNOSTIC_TOKEN_PATTERN, MEMORY_DIAGNOSTIC_REDACTED)
    .replace(MEMORY_DIAGNOSTIC_HOME_PATH_PATTERN, "~");
}

export interface SanitizeMemoryDiagnosticOptions {
  maxDepth?: number;
  maxKeys?: number;
  maxArrayLength?: number;
}

/**
 * 递归脱敏任意值：
 * - 只保留 null / boolean / 有限数字 / 脱敏后的字符串；
 * - 数组与普通对象受长度、键数与深度上限约束；
 * - 命中敏感键名时整段替换；
 * - Map/Set/Date/类实例/函数/symbol/bigint 等未知对象一律变成占位符，绝不展开。
 *
 * 这是"每条记录都过一遍"的兜底，不是业务投影；业务字段仍由
 * `sanitizeCliMemoryDiagnostic` 做白名单投影。
 */
export function sanitizeMemoryDiagnosticValue(
  value: unknown,
  options: SanitizeMemoryDiagnosticOptions = {},
  depth = 0,
): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : MEMORY_DIAGNOSTIC_PLACEHOLDER;
    case "string":
      return sanitizeMemoryDiagnosticString(value);
    case "object":
      break;
    default:
      // undefined / bigint / symbol / function
      return MEMORY_DIAGNOSTIC_PLACEHOLDER;
  }

  const maxDepth = options.maxDepth ?? MEMORY_DIAGNOSTIC_MAX_DEPTH;
  if (depth >= maxDepth) return MEMORY_DIAGNOSTIC_DEPTH_LIMIT;

  if (Array.isArray(value)) {
    const maxArrayLength = options.maxArrayLength ?? MEMORY_DIAGNOSTIC_MAX_ARRAY;
    return value
      .slice(0, maxArrayLength)
      .map((item) => sanitizeMemoryDiagnosticValue(item, options, depth + 1));
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return MEMORY_DIAGNOSTIC_PLACEHOLDER;
  }

  const maxKeys = options.maxKeys ?? MEMORY_DIAGNOSTIC_MAX_KEYS;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  let count = 0;
  for (const key of Object.keys(source)) {
    if (count >= maxKeys) break;
    count += 1;
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    result[key] = MEMORY_DIAGNOSTIC_SECRET_KEY_PATTERN.test(key)
      ? MEMORY_DIAGNOSTIC_REDACTED
      : sanitizeMemoryDiagnosticValue(source[key], options, depth + 1);
  }
  return result;
}

/** 记录级递归脱敏：非普通对象输入返回空对象。 */
export function sanitizeMemoryDiagnosticRecord(
  record: Record<string, unknown>,
  options: SanitizeMemoryDiagnosticOptions = {},
): Record<string, unknown> {
  const safe = sanitizeMemoryDiagnosticValue(record, options);
  return safe !== null && typeof safe === "object" && !Array.isArray(safe)
    ? (safe as Record<string, unknown>)
    : {};
}

function readDiagnosticNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), Number.MAX_SAFE_INTEGER)
    : 0;
}

function readDiagnosticToken(value: unknown, maxLength = 80): string {
  if (
    typeof value !== "string" ||
    !new RegExp(`^[A-Za-z0-9._+-]{1,${maxLength}}$`).test(value)
  ) {
    return "";
  }
  // 即使字符集允许，看起来像令牌的值（sk-… / ghp_…）也不能进记录。
  return sanitizeMemoryDiagnosticString(value) === value ? value : "";
}

function readDiagnosticCounters(value: unknown): Record<string, number> {
  const counters: Record<string, number> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return counters;
  let count = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (count >= CLI_MEMORY_MAX_COUNTER_KEYS) break;
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key)) continue;
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    counters[key] = readDiagnosticNumber(raw);
    count += 1;
  }
  return counters;
}

function readDiagnosticError(value: unknown): string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(value) ? value : "";
}

/**
 * 记录的白名单投影（隐私边界）。
 *
 * 未知字段全部丢弃；数字裁剪为非负整数；标识符只接受受限字符集；
 * 数组与计数器数量封顶；错误只保留短错误码。磁盘上的文件因此不能通过
 * 手改字段注入路径、源码、消息或环境变量。
 */
export function sanitizeCliMemoryDiagnostic(value: unknown): CliMemoryDiagnostic | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (raw.format !== CLI_MEMORY_DIAGNOSTIC_FORMAT) return null;
  const samplerRaw = raw.sampler;
  if (samplerRaw === null || typeof samplerRaw !== "object" || Array.isArray(samplerRaw)) {
    return null;
  }
  const sampler = samplerRaw as Record<string, unknown>;
  const state = sampler.state;
  if (
    state !== "active" &&
    state !== "unsupported" &&
    state !== "budget-exceeded" &&
    state !== "error"
  ) {
    return null;
  }
  if (!Array.isArray(raw.samples)) return null;

  const samples: CliMemoryReading[] = [];
  for (const item of raw.samples.slice(-CLI_MEMORY_MAX_SAMPLES)) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const row = item as Record<string, unknown>;
    samples.push({
      at: readDiagnosticNumber(row.at),
      rss: readDiagnosticNumber(row.rss),
      heapUsed: readDiagnosticNumber(row.heapUsed),
      heapTotal: readDiagnosticNumber(row.heapTotal),
      external: readDiagnosticNumber(row.external),
      arrayBuffers: readDiagnosticNumber(row.arrayBuffers),
      heapLimit: readDiagnosticNumber(row.heapLimit),
      counters: readDiagnosticCounters(row.counters),
    });
  }

  const allocations: CliMemoryAllocation[] = [];
  if (Array.isArray(raw.allocations)) {
    for (const item of raw.allocations.slice(0, CLI_MEMORY_MAX_ALLOCATIONS)) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      if (!Array.isArray(row.stack)) continue;
      const stack: CliMemoryAllocation["stack"] = [];
      for (const frameRaw of row.stack.slice(-CLI_MEMORY_MAX_STACK_DEPTH)) {
        if (frameRaw === null || typeof frameRaw !== "object" || Array.isArray(frameRaw)) continue;
        const frame = frameRaw as Record<string, unknown>;
        const frameName =
          typeof frame.name === "string" && /^[A-Za-z0-9_$.[\]<>-]{0,64}$/.test(frame.name)
            ? frame.name
            : "";
        stack.push({
          // 函数名只允许标识符字符；路径、源码片段和带空格的名字全部丢弃。
          // 看起来像令牌的名字同样清空，避免通过栈帧绕过字符串脱敏。
          name: sanitizeMemoryDiagnosticString(frameName) === frameName ? frameName : "",
          line: readDiagnosticNumber(frame.line),
          column: readDiagnosticNumber(frame.column),
        });
      }
      allocations.push({ bytes: readDiagnosticNumber(row.bytes), stack });
    }
  }

  const countersRaw =
    raw.counters === null || typeof raw.counters !== "object" || Array.isArray(raw.counters)
      ? {}
      : (raw.counters as Record<string, unknown>);

  return {
    format: CLI_MEMORY_DIAGNOSTIC_FORMAT,
    timestamp: readDiagnosticNumber(raw.timestamp),
    instanceId:
      typeof raw.instanceId === "string" && /^[a-f0-9-]{36}$/.test(raw.instanceId)
        ? raw.instanceId
        : "",
    pid: readDiagnosticNumber(raw.pid),
    version: readDiagnosticToken(raw.version),
    commit: readDiagnosticToken(raw.commit),
    node: readDiagnosticToken(raw.node),
    v8: readDiagnosticToken(raw.v8),
    bundleSha256:
      typeof raw.bundleSha256 === "string" && /^[a-f0-9]{64}$/.test(raw.bundleSha256)
        ? raw.bundleSha256
        : "",
    sampler: {
      state,
      intervalBytes: readDiagnosticNumber(sampler.intervalBytes),
      windowStartedAt: readDiagnosticNumber(sampler.windowStartedAt),
      profileCapturedAt: readDiagnosticNumber(sampler.profileCapturedAt),
      durationMs: readDiagnosticNumber(sampler.durationMs),
    },
    samples,
    allocations,
    counters: {
      sampledTurns: readDiagnosticNumber(countersRaw.sampledTurns),
      droppedSamples: readDiagnosticNumber(countersRaw.droppedSamples),
      fileBytes: readDiagnosticNumber(countersRaw.fileBytes),
      lastError: readDiagnosticError(countersRaw.lastError),
    },
  };
}
