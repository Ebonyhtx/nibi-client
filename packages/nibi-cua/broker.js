/**
 * Broker 协议层（客户端 + 服务端共用）——把占位壳换成真实现。
 *
 * 线上格式（与宿主契约一致，证据见 vendor/freeall12-computer-use/docs/zcode-computer-use.md）：
 *   请求：一行 JSON `{id, method, params}`；方法名即工具名（14 工具 + permission_status/helper_health）。
 *   响应：一行 JSON `{id, ok:true, result}` / `{id, ok:false, error:{code, message}}`。
 *   连接：win32 命名管道 / Unix 域 socket；权限与对端校验在宿主/Helper 侧（见 windowCuaHelperHostSupport）。
 *
 * 这里只有传输与协议：**不含工具语义**（state_id / 帧台账 / 租约 / 防重放 / kill switch 在
 * createComputerUseRuntime 里）。
 */

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

export const BROKER_SOCKET_ENV = "NIBI_CUA_PERMISSION_BROKER_SOCKET";
export const BROKER_UNAVAILABLE_ENV = "NIBI_CUA_PERMISSION_BROKER_UNAVAILABLE";

/** 协议里合法的方法名：14 个工具 + 两个辅助查询。 */
export const BROKER_METHODS = Object.freeze([
  "list_apps",
  "list_windows",
  "get_app_state",
  "left_click",
  "left_click_drag",
  "scroll",
  "type",
  "set_value",
  "select_text",
  "key",
  "paste",
  "perform_action",
  "request_access",
  "stop_computer_control",
  "permission_status",
  "helper_health",
  // 内部辅助（非模型工具）：会话结束时释放输入租约。
  "release_input_lease",
]);

const READ_ONLY_METHODS = new Set([
  "list_apps",
  "list_windows",
  "get_app_state",
  "request_access",
  "permission_status",
  "helper_health",
  // 内部辅助（非模型工具）：会话结束时释放输入租约。
  "release_input_lease",
]);

export class BrokerError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use broker is unavailable.");
    this.name = "BrokerError";
    this.code = options.code ?? "unavailable";
    if (options.details !== undefined) this.details = options.details;
  }
}

export class CuaHelperError extends Error {
  constructor(message, options = {}) {
    super(message ?? "Computer Use Helper is unavailable.");
    this.name = "CuaHelperError";
    this.code = options.code ?? "helper_unavailable";
    // details 是语义的一部分：CONTROLLER_BUSY 要带 owner、STALE_STATE 要带 state_id 等，
    // 模型/UI 靠它说清"谁占着"。丢了它错误就只剩一句话（实测踩过）。
    if (options.details !== undefined) this.details = options.details;
  }
}

export function isCuaHelperError(value) {
  return value instanceof CuaHelperError;
}

const brokerErrorFactory = (code) => (message, details) =>
  new BrokerError(message ?? code, { code, details });

export const notAuthorized = brokerErrorFactory("not_authorized");
export const notSelectable = brokerErrorFactory("not_selectable");
export const notSettable = brokerErrorFactory("not_settable");
export const elementUnavailable = brokerErrorFactory("element_unavailable");
export const actionUnavailable = brokerErrorFactory("action_unavailable");
export const foregroundRequired = brokerErrorFactory("foreground_required");

/** 连上去、发一行请求、读一行响应。失败按类型分：连不上/超时 = BrokerError，Helper 报错 = CuaHelperError。 */
export async function callBrokerMethod(args) {
  const { socketPath, method, params, timeoutMs = 10_000 } = args ?? {};
  if (!socketPath || !method) throw new BrokerError("callBrokerMethod 需要 socketPath 与 method");
  const id = randomUUID();
  return await new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(
      () => finish(new BrokerError(`等待 ${method} 响应超时（${timeoutMs}ms）`, { code: "timeout" })),
      timeoutMs,
    );
    timer.unref?.();

    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id, method, params: params ?? null })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      const line = buffer.slice(0, index).trim();
      let payload;
      try {
        payload = JSON.parse(line);
      } catch (error) {
        finish(new BrokerError("响应不是合法 JSON", { code: "protocol", details: error }));
        return;
      }
      if (payload?.ok) {
        finish(undefined, payload.result);
        return;
      }
      const error = payload?.error ?? {};
      finish(
        new CuaHelperError(error.message ?? "Helper 报错", {
          code: typeof error.code === "string" ? error.code : "helper_error",
          ...(error.details === undefined ? {} : { details: error.details }),
        }),
      );
    });
    socket.on("error", (error) => finish(new BrokerError(error.message, { code: "unavailable" })));
    socket.on("close", () => finish(new BrokerError("连接在响应前关闭", { code: "unavailable" })));
  });
}

/** Helper 健康探针：问它的身份（pid/包标识）。连不上就抛，让上层判"不可用"。 */
export async function probeHelperHealth(socketPath, options = {}) {
  const report = await callBrokerMethod({
    socketPath,
    method: "helper_health",
    timeoutMs: options.timeoutMs ?? 3000,
  });
  return {
    bundleId: typeof report?.bundle_id === "string" && report.bundle_id ? report.bundle_id : null,
    pid: Number.isInteger(report?.pid) ? report.pid : null,
  };
}

/**
 * **稳定**端点：同一实例的宿主、Helper、探针、agent spawn env 必须拿到同一个名字，否则
 * "懒启动"这条链根本对不上——agent 带着一个没人监听的管道名去连，运行时只能报 unavailable
 * （实测：正式版里这是电脑操控一直不亮的原因；上游的管道名就叫
 * `\\\\.\\pipe\\nibi-cua-helper-default`，图谱里有实测证据）。
 *
 * 隔离：名字带**数据根指纹**——`-default` 只属于默认实例（`~/.nibi`），换根部署/dev 实例各自
 * 一个名字，互不串台（正是我们一直在修的那类跨实例缺陷）。
 */
export function resolveStableBrokerSocketPath(env = process.env) {
  const explicit = env[BROKER_SOCKET_ENV];
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const storageRootRaw =
    env.NIBI_STORAGE_DIR?.trim() || env.NIBI_DATA_BASE_DIR?.trim() || env.NIBI_HOME?.trim() || "";
  // 指纹前先归一化：启动器拼出的根可能带 `plugins\..` 这类未折叠段（实测：
  // run-desktop-dev.cmd 用 %CONTAINER%\.. 派生路径），归一化前后必须哈希出同一个名字，
  // 否则"宿主铸造的名字"和"agent 侧回落解析的名字"会分叉。
  const storageRoot = storageRootRaw ? normalize(storageRootRaw).replace(/[\\/]+$/, "") : "";
  const suffix = storageRoot
    ? createHash("sha256").update(storageRoot.replaceAll("\\", "/").toLowerCase()).digest("hex").slice(0, 8)
    : "default";
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\nibi-cua-helper-${suffix}`;
  }
  const base = join(tmpdir(), `nibi-cua-${process.getuid?.() ?? 0}`);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  try {
    chmodSync(base, 0o700);
  } catch {
    // 目录已存在且不是我们建的：交给宿主侧的 uid/权限校验去拒。
  }
  return join(base, `helper-${suffix}.sock`);
}

/**
 * 端点铸造/解析都返回**同一个稳定名字**（见上）。历史上这里按调用铸造随机名字，
 * 结果是"谁拿到哪个名字"取决于调用顺序——懒启动链必然错位。
 */
export function mintBrokerSocketPath(options = {}) {
  return resolveStableBrokerSocketPath(options.env ?? process.env);
}

export function resolveBrokerSocketPath(options = {}) {
  return resolveStableBrokerSocketPath(options.env ?? process.env);
}

/**
 * **临时**端点（每调用一个）：只给测试与"一次性的 dev helper"用。
 * 产品链路必须走稳定端点——用临时名字会让"agent 先起来、Helper 后拉起"对不上（实测踩过）。
 */
export function mintEphemeralBrokerSocketPath(options = {}) {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\nibi-cua-${randomUUID()}`;
  }
  const base = typeof options.dir === "string" && options.dir.trim() ? options.dir : tmpdir();
  const directory = join(base, `nibi-cua-${process.getuid?.() ?? 0}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // 同上：交给校验去拒。
  }
  return join(directory, `znrc-${randomUUID()}.sock`);
}

export function parseRequestLine(line) {
  const text = typeof line === "string" ? line.trim() : "";
  if (!text) return undefined;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== "object") return undefined;
  const method = typeof payload.method === "string" ? payload.method : "";
  if (!method) return undefined;
  return {
    id: typeof payload.id === "string" ? payload.id : null,
    method,
    ...(payload.params === undefined ? {} : { params: payload.params }),
  };
}

export function okResponse(result) {
  return { ok: true, result };
}

export function errorResponse(message, options = {}) {
  return {
    ok: false,
    error: {
      message,
      ...(options.code ? { code: options.code } : {}),
      ...(options.details === undefined ? {} : { details: options.details }),
    },
  };
}

export function errorResponseFromException(error) {
  const code = typeof error?.code === "string" ? error.code : undefined;
  return errorResponse(error instanceof Error ? error.message : String(error), {
    ...(code ? { code } : {}),
    ...(error?.details === undefined ? {} : { details: error.details }),
  });
}

/**
 * 线上序列化。**必须容忍 BigInt**：引擎（uniffi 绑定的 u64 字段，如 zIndex/句柄）
 * 返回 BigInt，`JSON.stringify` 遇到它会直接抛——实测真引擎一接上就因此让 Helper 退出（离线假引擎
 * 的数字是普通 number，测不出来）。安全范围内转 number，超出则转字符串（保真优先，别静默截断）。
 */
function jsonSafeReplacer(_key, value) {
  if (typeof value !== "bigint") return value;
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
}

export function serializeResponse(response) {
  return `${JSON.stringify(response, jsonSafeReplacer)}\n`;
}

/** 请求侧同样可能带 BigInt（例如客户端把帧序号回传）。 */
export function serializeRequest(request) {
  return `${JSON.stringify(request, jsonSafeReplacer)}\n`;
}

/**
 * 把一条请求派发到 backend（键 = 方法名，值 = async 函数）。
 * 未声明的方法**明确拒**（fail-closed），不静默、不猜。
 */
export async function dispatchRequest(backend, request) {
  const method = request?.method ?? "";
  const handler = backend && typeof backend === "object" ? backend[method] : undefined;
  if (typeof handler !== "function") {
    throw new CuaHelperError(`未知的 broker 方法：${method || "(空)"}`, { code: "unrecognized_method" });
  }
  const result = await handler(request.params, request);
  return okResponse(result);
}

export async function handleRequestLine(backend, line) {
  const request = parseRequestLine(line);
  if (!request) return errorResponse("请求不是合法的 broker 行", { code: "protocol" });
  try {
    return await dispatchRequest(backend, request);
  } catch (error) {
    return errorResponseFromException(error);
  }
}

export function isBrokerMethod(method) {
  return typeof method === "string" && BROKER_METHODS.includes(method);
}

export function isReadOnlyBrokerMethod(method) {
  return typeof method === "string" && READ_ONLY_METHODS.has(method);
}
