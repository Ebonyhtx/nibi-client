import { z } from "zod";

// 启动早期或协议故障时 stdout 尚不可用，进程诊断使用独立的 stderr 单行契约。
export const NIBI_PROCESS_DIAGNOSTIC_PREFIX = "[nibi-process-exception] ";
export const NIBI_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS = 128;
export const NIBI_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS = 4_000;
export const NIBI_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS = 16_000;
export const NIBI_PROCESS_DIAGNOSTIC_MAX_LINE_CHARS = 128 * 1024;
export const NIBI_AGENT_LIFECYCLE_LOG_MARKER = "[nibi-agent-lifecycle-reported]";

const processErrorKindSchema = z.enum(["uncaughtException", "unhandledRejection"]);
export const nibiProcessDiagnosticSchema = z
  .object({
    version: z.literal(1),
    errorId: z.uuid(),
    kind: processErrorKindSchema,
    origin: processErrorKindSchema,
    name: z.string().min(1).max(NIBI_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS),
    message: z.string().max(NIBI_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS),
    stack: z.string().max(NIBI_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS).optional(),
    occurredAt: z.number().int().nonnegative(),
  })
  .strict();
export type NibiProcessDiagnostic = z.infer<typeof nibiProcessDiagnosticSchema>;

export function parseNibiProcessDiagnostic(line: string): NibiProcessDiagnostic | undefined {
  if (
    !line.startsWith(NIBI_PROCESS_DIAGNOSTIC_PREFIX) ||
    line.length > NIBI_PROCESS_DIAGNOSTIC_MAX_LINE_CHARS
  ) {
    return undefined;
  }
  try {
    const result = nibiProcessDiagnosticSchema.safeParse(
      JSON.parse(line.slice(NIBI_PROCESS_DIAGNOSTIC_PREFIX.length)),
    );
    return result.success ? result.data : undefined;
  } catch {
    // 诊断旁路不得因损坏帧中断业务协议或退出处理。
    return undefined;
  }
}

/**
 * 退出/崩溃诊断的共享纯函数。
 *
 * 同一份分类、指纹与脱敏规则同时服务 Desktop Main 和 Node Agent 退出路径，
 * 避免两边各写一套 regex 后产生不同的 crash 归因。
 *
 * Rust 内核（`kernel/crates/env-local`）只把 shell 退出事实写成
 * `Outcome`/`exit_code`（`CommandEvent::Finished`），panic 文本也直接落 stderr；
 * 它没有崩溃分类或指纹的 JSON 契约，因此 Rust 侧不消费本模块，由 Node/Host
 * 适配层对原始 stderr 统一调用这里的纯函数。
 */

export type CrashCategory =
  | "normal"
  | "crash"
  | "oom"
  | "killed"
  | "startupFailure"
  | "toolFailure"
  | "unknown";

/** 与 Desktop 现有 `diagnostic_class` 取值保持一致。 */
export type DiagnosticClass = "oom" | "sqlite" | "errno" | "generic" | "none";

/** Windows 受控终止退出码（服务控制/CTRL_C_EVENT 的包装）。 */
const WINDOWS_CONTROLLED_TERMINATION_EXIT_CODE = 0x40010004;

/**
 * Chromium/PartitionAlloc 在 Windows 上内存分配失败时终止进程的异常码（kOomExceptionCode）。
 * Agent runtime 以 ELECTRON_RUN_AS_NODE 运行在同一个 Electron 可执行文件里，系统可提交内存
 * 耗尽时以它退出，且通常不写 stderr。Node 报无符号值，个别通道可能给出有符号 int32，统一按
 * 32 位无符号比较。其它平台没有同等确定的签名，不按信号推断 OOM。
 */
const WINDOWS_NATIVE_OUT_OF_MEMORY_EXIT_CODE = 0xe0000008;

const OOM_DIAGNOSTIC_PATTERN = /\b(?:JavaScript heap out of memory|Reached heap limit)\b/i;
const SQLITE_DIAGNOSTIC_PATTERN =
  /\bSQLiteError\b|\bSQLite\s+(?:migration|database|initialization|lock)\b|\bdatabase (?:is locked|disk image is malformed)\b/i;
const EXPLICIT_ERROR_CODE_PATTERN = /\bcode:\s*["']?([A-Z][A-Z0-9_]+)\b/i;
const ERROR_CODE_TOKEN_PATTERN =
  /\b(?:[A-Z]+_ERR_[A-Z0-9_]+|ERR_[A-Z0-9_]+|SQLITE_[A-Z0-9_]+|E[A-Z0-9_]{2,})\b/g;
const ERROR_NAME_PATTERN = /^(?:[A-Za-z_$][\w$]*Error|Error):\s*/;
const ERROR_NAME_CAPTURE_PATTERN = /^([A-Za-z_$][\w$]*Error|Error):\s*(.*)$/;
const EXCEPTION_SUMMARY_PATTERN = /\b(?:Exception|fatal|panic|process exited)\b/i;

const KILLED_SIGNALS = new Set(["SIGTERM", "SIGINT", "SIGKILL", "SIGHUP", "SIGQUIT"]);
const NORMAL_REASONS = new Set(["clean-exit", "normal", "expected"]);
const KILLED_REASONS = new Set(["killed", "terminated"]);
// 结构化崩溃根因优先于随后用于回收进程的 SIGTERM；Desktop 也把 protocol-close
// 视为 crash，而不是受控终止。
const CRASH_REASONS = new Set([
  "crashed",
  "abnormal",
  "abnormal-exit",
  "protocol-close",
  "integrity-failure",
]);
const STARTUP_FAILURE_REASONS = new Set(["launch-failed", "launch_failed"]);
const TOOL_FAILURE_REASONS = new Set([
  "tool-failure",
  "tool_failure",
  "tool-error",
  "tool_error",
]);

const SENSITIVE_ASSIGNMENT_PATTERN =
  /(["']?(?:api[-_]?key|authorization|cookie|credential|password|secret|token)["']?\s*[:=]\s*)(?!(?:Bearer|Basic)\b)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const AUTH_SCHEME_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const API_KEY_PATTERN = /\b(sk-)[A-Za-z0-9_-]{16,}\b/gi;
const URL_CREDENTIAL_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s@]+)@/gi;
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const ISO_TIMESTAMP_PATTERN =
  /\b\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T]\d{1,2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g;
const NAMED_EPOCH_TIMESTAMP_PATTERN = /\b(timestamp|time|ts)\s*[:=]\s*\d{10,13}\b/gi;
const EPOCH_TIMESTAMP_PATTERN = /\b\d{10,13}\b/g;
const STACK_LOCATION_PATTERN = /:\d+:\d+/g;
const PID_PATTERN = /\bpid\s*[:=]\s*\d+\b/gi;
const NODE_PID_PATTERN = /\bnode:\d+\b/g;
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const USER_ASSIGNMENT_PATTERN = /\b(user|username|user_name|login)\s*[:=]\s*[^\s,;}]+/gi;
const POSIX_HOME_PATTERN = /\/(?:Users|home)\/[^/\s"'`()[\]{}<>]+/g;
const WINDOWS_HOME_PATTERN = /\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`()[\]{}<>]+/gi;
const WINDOWS_ABSOLUTE_PATH_PATTERN =
  /\b[A-Za-z]:[\\/](?:[^\\/\s"'`()[\]{}<>:]+[\\/])*[^\\/\s"'`()[\]{}<>:]+/g;
const POSIX_ABSOLUTE_PATH_PATTERN = /\/(?:[^/\s"'`()[\]{}<>:]+\/)*[^/\s"'`()[\]{}<>:]+/g;
const KNOWN_PATH_PLACEHOLDER_PATTERN = /<(?:workspace|home)>[^\s"'`()[\]{}<>]*/g;

const DEFAULT_MAX_LENGTH = 4_000;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_MAX_DIAGNOSTICS = 20;
const FINGERPRINT_MAX_SOURCE_LENGTH = 1_000;

export interface ExitInfo {
  exitCode?: number | null;
  signal?: string | null;
  /**
   * Electron `RenderProcessGoneDetails.reason` 或 Host `terminationReason`。
   * 例：clean-exit / crashed / oom / memory-eviction / killed / launch-failed /
   * protocol-close / tool-failure。
   */
  reason?: string | null;
  /** terminationKind === "expected" / "watchdog_recycle" 时为 true。 */
  expected?: boolean | null;
  /** Agent 是否已经完成 ready 握手；false 表示启动阶段退出。 */
  runtimeReady?: boolean | null;
  /** 原始或已脱敏的 stderr / 诊断文本。 */
  diagnosticText?: string | null;
  /** 已解析的诊断；存在时优先于 diagnosticText。 */
  diagnostics?: readonly Pick<StderrDiagnostic, "class" | "code">[];
}

/**
 * 把一次退出归一为稳定类别。优先级：
 * OOM 证据 > 预期退出 > 受控 kill > 启动失败 > 工具失败 > 崩溃 > 正常 > 未知。
 *
 * 说明：`expected: false` 的 0 退出码仍归为 crash，因为上层已经明确这是非预期退出；
 * 裸 `{ exitCode: 0 }`（没有 expected 事实）才归为 normal。
 */
export function classifyExit(info: ExitInfo): CrashCategory {
  const reason = normalizeReason(info.reason);
  const signal = info.signal?.toUpperCase() ?? "";
  const diagnosticText = info.diagnosticText ?? "";
  const diagnosticCodes = info.diagnostics?.map((diagnostic) => diagnostic.code) ?? [];
  const textCode = extractDiagnosticCode(diagnosticText);
  const hasOomEvidence =
    reason === "oom" ||
    reason === "memory-eviction" ||
    reason === "out-of-memory" ||
    (typeof info.exitCode === "number" &&
      info.exitCode >>> 0 === WINDOWS_NATIVE_OUT_OF_MEMORY_EXIT_CODE) ||
    info.diagnostics?.some((diagnostic) => diagnostic.class === "oom") === true ||
    OOM_DIAGNOSTIC_PATTERN.test(diagnosticText) ||
    diagnosticCodes.includes("ERR_OUT_OF_MEMORY") ||
    textCode === "ERR_OUT_OF_MEMORY";

  if (hasOomEvidence) {
    return "oom";
  }
  if (info.expected === true || NORMAL_REASONS.has(reason)) {
    return "normal";
  }
  if (CRASH_REASONS.has(reason)) {
    return "crash";
  }
  if (
    KILLED_REASONS.has(reason) ||
    KILLED_SIGNALS.has(signal) ||
    info.exitCode === WINDOWS_CONTROLLED_TERMINATION_EXIT_CODE
  ) {
    return "killed";
  }
  if (STARTUP_FAILURE_REASONS.has(reason)) {
    return "startupFailure";
  }
  if (
    TOOL_FAILURE_REASONS.has(reason) ||
    diagnosticCodes.some(isToolFailureCode) ||
    isToolFailureCode(textCode)
  ) {
    return "toolFailure";
  }
  if (info.runtimeReady === false) {
    return "startupFailure";
  }
  if (info.exitCode != null && info.exitCode !== 0) {
    return "crash";
  }
  // SIGSEGV / SIGABRT 等崩溃信号不能归为外部 kill。
  if (signal) {
    return "crash";
  }
  if (info.exitCode === 0) {
    return info.expected === false ? "crash" : "normal";
  }
  if (info.expected === false) {
    return "crash";
  }
  return "unknown";
}

export interface CrashFingerprintInfo {
  /**
   * 显式指纹组成。Desktop 既有三字段/四字段调用通过它保持 hash 不变。
   * 提供后 name/code/message/stack 不再参与。
   */
  parts?: readonly string[];
  name?: string | null;
  code?: string | null;
  message?: string | null;
  stack?: string | readonly string[] | null;
  /** 以下字段只用于说明调用方事实，指纹会忽略它们。 */
  exitCode?: number | null;
  signal?: string | null;
  pid?: number | null;
  timestamp?: number | string | null;
}

// 修复原因：packages/shared/src/nibi-protocol/index.ts 与 validation.ts 会重新导出本模块，
// 从而被 Electron renderer 与 Web 浏览器入口直接打包；顶层导入 `node:crypto` 在 Vite
// 浏览器构建下会被替换成抛错代理（Cannot access "node:crypto.createHash" in client code），
// 导致渲染进程在 React 与 styles.css 加载前即崩溃白屏。这里改用纯 TypeScript 同步 SHA-256，
// 保持跨进程（Main / Node Host / Browser）崩溃指纹字节级一致且零 Node 内置依赖。
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const utf8Encoder = new TextEncoder();

function sha256Hex(input: string): string {
  const bytes = utf8Encoder.encode(input);
  const paddedLength = Math.ceil((bytes.length + 1 + 8) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;

  const view = new DataView(padded.buffer);
  const highBits = Math.floor(bytes.length / 0x20000000);
  const lowBits = (bytes.length << 3) >>> 0;
  view.setUint32(paddedLength - 8, highBits, false);
  view.setUint32(paddedLength - 4, lowBits, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15] ?? 0;
      const w2 = w[i - 2] ?? 0;
      const s0 = ((w15 >>> 7) | (w15 << 25)) ^ ((w15 >>> 18) | (w15 << 14)) ^ (w15 >>> 3);
      const s1 = ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + (SHA256_K[i] ?? 0) + (w[i] ?? 0)) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
}

/**
 * 生成 16 位稳定指纹。pid、时间戳、绝对路径、home 目录、UUID 和栈行列号
 * 在 hash 前统一归一，因此同一根因跨进程/跨机器得到同一指纹。
 */
export function fingerprintCrash(info: CrashFingerprintInfo): string {
  const parts =
    info.parts ??
    [info.name ?? "", info.code ?? "", info.message ?? "", firstStackFrameOf(info.stack)];
  return sha256Hex(parts.map(normalizeCrashFingerprintSource).join("|")).slice(0, 16);
}

export type DiagnosticJsonValue =
  | string
  | number
  | boolean
  | null
  | DiagnosticJsonValue[]
  | { [key: string]: DiagnosticJsonValue };

export interface SanitizeDiagnosticOptions {
  /** 工作区根路径；命中时替换为 `<workspace>`。 */
  workspacePath?: string;
  /** 单个字符串的最大长度，默认 4000；Infinity 表示不截断。 */
  maxLength?: number;
  /** 结构化值的最大递归深度，默认 4。 */
  maxDepth?: number;
  /** 是否脱敏 home 与其它绝对路径，默认 true。 */
  redactPaths?: boolean;
  /** 是否脱敏 URL userinfo，默认 true。 */
  redactUrlCredentials?: boolean;
}

/**
 * 脱敏诊断文本。字符串按固定顺序处理：workspace → URL 凭据 → home/绝对路径 →
 * token/Bearer/sk- → 截断。结构化值按 maxDepth 递归处理，超过深度输出
 * `<depth-limit>`，避免调用方把任意深对象直接塞进日志。
 */
export function sanitizeDiagnosticText(
  text: string,
  options?: SanitizeDiagnosticOptions,
): string;
export function sanitizeDiagnosticText(
  value: DiagnosticJsonValue,
  options?: SanitizeDiagnosticOptions,
): DiagnosticJsonValue;
export function sanitizeDiagnosticText(
  value: string | DiagnosticJsonValue,
  options: SanitizeDiagnosticOptions = {},
): string | DiagnosticJsonValue {
  return typeof value === "string"
    ? sanitizeDiagnosticString(value, options)
    : sanitizeDiagnosticValue(value, options, 0);
}

export interface StderrDiagnostic {
  /** 与 Desktop `diagnostic_class` 相同的分类。 */
  class: DiagnosticClass;
  /** 结构化错误名，无法识别时为 `AgentProcessExit`；OOM 为 `AgentOutOfMemory`。 */
  name: string;
  /** 行级错误码，例如 EPIPE / SQLITE_BUSY / ERR_OUT_OF_MEMORY。 */
  code: string;
  /** 归一后的摘要（去 Error 前缀、反斜杠转正斜杠、截断）。 */
  message: string;
  /** 去空白后的原始诊断行（有界）。 */
  line: string;
  /** 在原输入中的 1 基行号。 */
  lineNumber: number;
  /** 同指纹诊断折叠后的出现次数。 */
  occurrences: number;
  /** name/code/message/firstStackFrame 的稳定指纹。 */
  fingerprint: string;
}

export interface ParsedStderrDiagnostics {
  /** 去噪、去重、按主诊断优先级排序后的有界诊断列表。 */
  diagnostics: StderrDiagnostic[];
  /** 与旧逻辑 `errorLine` 等价的主诊断；没有可用行时为 null。 */
  primary: StderrDiagnostic | null;
  errorName: string;
  errorCode: string;
  /** 主诊断摘要；没有主诊断时调用方自行提供 fallback。 */
  errorMessage: string | null;
  diagnosticClass: DiagnosticClass;
  /** 第一条 `at ` 栈帧（未脱敏，由输入决定）。 */
  firstStackFrame: string;
  /** 输入的非空行数。 */
  lineCount: number;
  /** 是否发生了诊断数量或行长截断。 */
  truncated: boolean;
}

export interface ParseStderrDiagnosticsOptions {
  /** 最多保留的诊断条数，默认 20。 */
  maxDiagnostics?: number;
  /** 单条 `line` 最大长度，默认 4000。 */
  maxLineLength?: number;
  /** 单条 `message` 最大长度，默认 4000。 */
  maxMessageLength?: number;
}

/**
 * 解析 stderr 行为类型化诊断。去噪、去重（按稳定指纹）与数量/长度上限都在这里，
 * Desktop 与 Node Agent 退出路径共用同一套主诊断选择顺序：
 * OOM → SQLite → errno → `Error:` → Exception/fatal/panic → 第一条有效行。
 */
export function parseStderrDiagnostics(
  input: string | readonly string[],
  options: ParseStderrDiagnosticsOptions = {},
): ParsedStderrDiagnostics {
  const text = typeof input === "string" ? input : input.join("\n");
  const maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LENGTH;
  const maxMessageLength = options.maxMessageLength ?? DEFAULT_MAX_LENGTH;
  const requestedMaxDiagnostics = options.maxDiagnostics ?? DEFAULT_MAX_DIAGNOSTICS;
  const maxDiagnostics = Number.isFinite(requestedMaxDiagnostics)
    ? Math.max(0, Math.floor(requestedMaxDiagnostics))
    : DEFAULT_MAX_DIAGNOSTICS;

  const rawLines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const firstStackFrame = firstStackFrameOf(rawLines);
  const lineTruncated = rawLines.some((line) => line.length > maxLineLength);
  const byFingerprint = new Map<string, StderrDiagnostic & { rank: number; firstIndex: number }>();

  for (const [index, line] of rawLines.entries()) {
    if (isDiagnosticNoise(line)) {
      continue;
    }
    const lineCode = extractDiagnosticCode(line);
    const diagnosticClass = classifyDiagnosticText(line, lineCode, true);
    const code = diagnosticClass === "oom" ? "ERR_OUT_OF_MEMORY" : lineCode;
    const { name, message } = deriveDiagnosticSummary(line, diagnosticClass);
    const normalizedMessage = truncateDiagnosticText(
      message.replace(/\\/g, "/").trim(),
      maxMessageLength,
    );
    const boundedLine = truncateDiagnosticText(line, maxLineLength);
    const fingerprint = fingerprintCrash({
      parts: [name, code, normalizedMessage, firstStackFrame],
    });
    const rank = diagnosticRank(line, code, diagnosticClass);
    const existing = byFingerprint.get(fingerprint);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    byFingerprint.set(fingerprint, {
      class: diagnosticClass,
      name,
      code,
      message: normalizedMessage,
      line: boundedLine,
      lineNumber: index + 1,
      occurrences: 1,
      fingerprint,
      rank,
      firstIndex: index,
    });
  }

  const ordered = [...byFingerprint.values()].sort(
    (left, right) => left.rank - right.rank || left.firstIndex - right.firstIndex,
  );
  const diagnostics = ordered.slice(0, maxDiagnostics).map((diagnostic) => ({
    class: diagnostic.class,
    name: diagnostic.name,
    code: diagnostic.code,
    message: diagnostic.message,
    line: diagnostic.line,
    lineNumber: diagnostic.lineNumber,
    occurrences: diagnostic.occurrences,
    fingerprint: diagnostic.fingerprint,
  }));
  const primary = diagnostics[0] ?? null;
  const errorCode =
    primary?.class === "oom"
      ? "ERR_OUT_OF_MEMORY"
      : extractDiagnosticCode(`${primary?.message ?? ""}\n${text}`);
  const hasUsefulSummary = primary != null;
  return {
    diagnostics,
    primary,
    errorName: primary?.name ?? "AgentProcessExit",
    errorCode,
    errorMessage: primary?.message ?? null,
    diagnosticClass: classifyDiagnosticText(
      `${primary?.message ?? ""}\n${text}`,
      errorCode,
      hasUsefulSummary,
    ),
    firstStackFrame,
    lineCount: rawLines.length,
    truncated: lineTruncated || ordered.length > diagnostics.length,
  };
}

/** 提取显式 `code: "X"` 或已知错误码 token；排除无信息量的 ERROR。 */
function extractDiagnosticCode(value: string): string {
  const explicit = value.match(EXPLICIT_ERROR_CODE_PATTERN)?.[1]?.toUpperCase();
  if (explicit && explicit !== "ERROR") {
    return explicit;
  }
  return (
    value
      .match(ERROR_CODE_TOKEN_PATTERN)
      ?.find((candidate) => candidate !== "ERROR") ?? ""
  );
}

/** 按固定优先级给出诊断分类；与 Desktop 既有 `diagnostic_class` 完全一致。 */
export function classifyDiagnosticText(
  value: string,
  errorCode: string,
  hasUsefulSummary: boolean,
): DiagnosticClass {
  if (OOM_DIAGNOSTIC_PATTERN.test(value)) {
    return "oom";
  }
  if (isSqliteDiagnostic(value, errorCode)) {
    return "sqlite";
  }
  if (isErrnoCode(errorCode)) {
    return "errno";
  }
  return hasUsefulSummary ? "generic" : "none";
}

function sanitizeDiagnosticString(value: string, options: SanitizeDiagnosticOptions): string {
  const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
  if (value.length === 0) {
    return value;
  }
  let result = options.workspacePath
    ? value.split(options.workspacePath).join("<workspace>")
    : value;
  if (options.redactUrlCredentials !== false) {
    result = result.replace(URL_CREDENTIAL_PATTERN, "$1<redacted>@");
  }
  if (options.redactPaths !== false) {
    result = redactRemainingAbsolutePaths(
      result.replace(WINDOWS_HOME_PATTERN, "<home>").replace(POSIX_HOME_PATTERN, "<home>"),
    );
  }
  result = result
    // 先处理 Authorization: Bearer <token>：如果先跑 assignment 规则，
    // group 2 只会吃掉 "Bearer"，后面的 token 反而泄漏。
    .replace(AUTH_SCHEME_PATTERN, "$1 <redacted>")
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, "$1<redacted>")
    .replace(API_KEY_PATTERN, "$1<redacted>");
  return truncateDiagnosticText(result, maxLength);
}

function sanitizeDiagnosticValue(
  value: DiagnosticJsonValue,
  options: SanitizeDiagnosticOptions,
  depth: number,
): DiagnosticJsonValue {
  if (typeof value === "string") {
    return sanitizeDiagnosticString(value, options);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (depth >= maxDepth) {
    return "<depth-limit>";
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnosticValue(item, options, depth + 1));
  }
  const result: Record<string, DiagnosticJsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = sanitizeDiagnosticValue(item, options, depth + 1);
  }
  return result;
}

function redactRemainingAbsolutePaths(value: string): string {
  const protectedPaths: string[] = [];
  const protectedValue = value.replace(KNOWN_PATH_PLACEHOLDER_PATTERN, (match) => {
    const index = protectedPaths.push(match) - 1;
    return `NIBI_REDACTED_PATH_${index}_TOKEN`;
  });
  const redacted = protectedValue
    .replace(WINDOWS_ABSOLUTE_PATH_PATTERN, "<path>")
    .replace(POSIX_ABSOLUTE_PATH_PATTERN, "<path>");
  return protectedPaths.reduce(
    (result, protectedPath, index) =>
      result.replace(`NIBI_REDACTED_PATH_${index}_TOKEN`, protectedPath),
    redacted,
  );
}

function normalizeCrashFingerprintSource(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(URL_CREDENTIAL_PATTERN, "$1<redacted>@")
    .replace(UUID_PATTERN, "<uuid>")
    .replace(ISO_TIMESTAMP_PATTERN, "<timestamp>")
    .replace(NAMED_EPOCH_TIMESTAMP_PATTERN, "$1=<timestamp>")
    .replace(EPOCH_TIMESTAMP_PATTERN, "<timestamp>")
    .replace(STACK_LOCATION_PATTERN, ":<line>:<column>")
    .replace(PID_PATTERN, "pid=<pid>")
    .replace(NODE_PID_PATTERN, "node:<pid>")
    .replace(EMAIL_PATTERN, "<user>")
    .replace(USER_ASSIGNMENT_PATTERN, "$1=<user>")
    .replace(WINDOWS_ABSOLUTE_PATH_PATTERN, "<path>")
    .replace(POSIX_ABSOLUTE_PATH_PATTERN, "<path>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, FINGERPRINT_MAX_SOURCE_LENGTH);
}

function firstStackFrameOf(stack: string | readonly string[] | null | undefined): string {
  if (stack == null) {
    return "";
  }
  const lines = typeof stack === "string" ? stack.split(/\r?\n/) : stack;
  return lines.map((line) => line.trim()).find((line) => line.startsWith("at ")) ?? "";
}

function normalizeReason(reason: string | null | undefined): string {
  return reason?.trim().toLowerCase() ?? "";
}

function isToolFailureCode(code: string): boolean {
  return /^(?:ERR_)?TOOL_[A-Z0-9_]+$/.test(code);
}

function isErrnoCode(errorCode: string): boolean {
  return /^E[A-Z0-9_]{2,}$/.test(errorCode) && !errorCode.startsWith("ERR_");
}

function isSqliteDiagnostic(value: string, errorCode: string): boolean {
  return /^SQLITE_/i.test(errorCode) || SQLITE_DIAGNOSTIC_PATTERN.test(value);
}

function isDiagnosticNoise(line: string): boolean {
  return (
    /\[Object\]/i.test(line) ||
    /^node:(?:events|internal)\b/i.test(line) ||
    /^at\s+/i.test(line) ||
    /^\d+:\s*0x[0-9a-f]+\b/i.test(line) ||
    /^\[\d+:0x[0-9a-f]+\]/i.test(line) ||
    /^<---.*--->$/.test(line) ||
    /^-+\s*(?:Native stack trace|JS stacktrace)\s*-+$/i.test(line) ||
    /^\(node:\d+\)\s*ExperimentalWarning:/i.test(line) ||
    /^\(Use `.*--trace-warnings.*\)$/i.test(line) ||
    /^(?:throw er;|Emitted ['"]error['"] event on .* instance at:)$/i.test(line) ||
    /^[}\]]\s*,?$/.test(line) ||
    /^(?:\{|\[)$/.test(line) ||
    /^["']?[\w-]+["']?\s*:\s*(?:\{|\[)$/.test(line) ||
    /^["']?code["']?\s*:\s*["'][A-Z0-9_]+["'],?$/i.test(line)
  );
}

function deriveDiagnosticSummary(
  line: string,
  diagnosticClass: DiagnosticClass,
): { name: string; message: string } {
  if (diagnosticClass === "oom") {
    return {
      name: "AgentOutOfMemory",
      message: line.replace(/^FATAL ERROR:\s*/i, ""),
    };
  }
  const match = line.match(ERROR_NAME_CAPTURE_PATTERN);
  if (match) {
    return { name: match[1] ?? "AgentProcessExit", message: (match[2] ?? "").trim() || line };
  }
  return { name: "AgentProcessExit", message: line };
}

function diagnosticRank(line: string, code: string, diagnosticClass: DiagnosticClass): number {
  if (diagnosticClass === "oom") {
    return 0;
  }
  // 旧逻辑显式跳过 ExperimentalWarning 作为 sqlite 主行，但它仍参与 generic 兜底。
  if (diagnosticClass === "sqlite" && !/ExperimentalWarning:/i.test(line)) {
    return 1;
  }
  if (isErrnoCode(code)) {
    return 2;
  }
  if (ERROR_NAME_PATTERN.test(line)) {
    return 3;
  }
  if (EXCEPTION_SUMMARY_PATTERN.test(line)) {
    return 4;
  }
  return 5;
}

function truncateDiagnosticText(value: string, maxLength: number): string {
  if (!Number.isFinite(maxLength) || value.length <= maxLength) {
    return value;
  }
  return value.slice(0, Math.max(0, maxLength));
}
