/**
 * Public broker protocol surface.
 *
 * This module contains the wire contract used by the open-source client:
 * request/response envelopes, method names, socket naming, and error codes.
 * It does not contain a native engine. The RPC entry points fail closed with
 * `code: "unavailable"` because the real Helper is shipped only in official
 * NIBI builds.
 */

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

export const BROKER_SOCKET_ENV = "NIBI_CUA_PERMISSION_BROKER_SOCKET";
export const BROKER_UNAVAILABLE_ENV = "NIBI_CUA_PERMISSION_BROKER_UNAVAILABLE";

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
  "release_input_lease",
]);

const READ_ONLY_METHODS = new Set([
  "list_apps",
  "list_windows",
  "get_app_state",
  "request_access",
  "permission_status",
  "helper_health",
  "release_input_lease",
]);

const UNAVAILABLE_TEXT = "Computer Use is not available in this build.";

export class BrokerError extends Error {
  constructor(message = "Broker request failed", options = {}) {
    super(message);
    this.name = "BrokerError";
    this.code = options.code ?? "broker";
    if (options.details !== undefined) this.details = options.details;
  }
}

export class CuaHelperError extends Error {
  constructor(message = "Computer Use helper failed", options = {}) {
    super(message);
    this.name = "CuaHelperError";
    this.code = options.code ?? "helper";
  }
}

export function isCuaHelperError(value) {
  return value instanceof CuaHelperError;
}

export const notAuthorized = (message, details) =>
  new BrokerError(message ?? "Computer Use request is not authorized.", {
    code: "not_authorized",
    details,
  });
export const notSelectable = (message, details) =>
  new BrokerError(message ?? "The requested element is not selectable.", {
    code: "not_selectable",
    details,
  });
export const notSettable = (message, details) =>
  new BrokerError(message ?? "The requested element is not settable.", {
    code: "not_settable",
    details,
  });
export const elementUnavailable = (message, details) =>
  new BrokerError(message ?? "The requested element is unavailable.", {
    code: "element_unavailable",
    details,
  });
export const actionUnavailable = (message, details) =>
  new BrokerError(message ?? "The requested action is unavailable.", {
    code: "action_unavailable",
    details,
  });
export const foregroundRequired = (message, details) =>
  new BrokerError(message ?? "The target application must be in the foreground.", {
    code: "foreground_required",
    details,
  });

function unavailable() {
  return new BrokerError(UNAVAILABLE_TEXT, { code: "unavailable" });
}

export async function callBrokerMethod(_args) {
  throw unavailable();
}

export async function probeHelperHealth(_socketPath, _options) {
  throw unavailable();
}

/**
 * Stable endpoint naming: every participant in one app instance must derive the
 * same name so that lazy Helper startup can rendezvous. The suffix is a digest
 * of the configured data root, which keeps separate instances isolated.
 */
export function resolveStableBrokerSocketPath(env = process.env) {
  const explicit = env[BROKER_SOCKET_ENV];
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  const storageRootRaw =
    env.NIBI_STORAGE_DIR?.trim() || env.NIBI_DATA_BASE_DIR?.trim() || env.NIBI_HOME?.trim() || "";
  const storageRoot = storageRootRaw ? normalize(storageRootRaw).replace(/[\\/]+$/, "") : "";
  const suffix = storageRoot
    ? createHash("sha256")
        .update(storageRoot.replaceAll("\\", "/").toLowerCase())
        .digest("hex")
        .slice(0, 8)
    : "default";
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\zcode-cua-helper-${suffix}`;
  }
  const base = join(tmpdir(), `zcode-cua-${process.getuid?.() ?? 0}`);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  try {
    chmodSync(base, 0o700);
  } catch {
    // The host-side permission check remains the authority on directory ownership.
  }
  return join(base, `helper-${suffix}.sock`);
}

export function mintBrokerSocketPath(options = {}) {
  return resolveStableBrokerSocketPath(options.env ?? process.env);
}

export function resolveBrokerSocketPath(options = {}) {
  return resolveStableBrokerSocketPath(options.env ?? process.env);
}

/** Ephemeral endpoint for tests and one-shot helper processes. */
export function mintEphemeralBrokerSocketPath(options = {}) {
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\zcode-cua-${randomUUID()}`;
  }
  const base = typeof options.dir === "string" && options.dir.trim() ? options.dir : tmpdir();
  const directory = join(base, `zcode-cua-${process.getuid?.() ?? 0}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(directory, 0o700);
  } catch {
    // The host-side permission check remains the authority.
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

function jsonSafeReplacer(_key, value) {
  if (typeof value !== "bigint") return value;
  return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(value)
    : value.toString();
}

export function serializeResponse(response) {
  return `${JSON.stringify(response, jsonSafeReplacer)}\n`;
}

export function serializeRequest(request) {
  return `${JSON.stringify(request, jsonSafeReplacer)}\n`;
}

export async function dispatchRequest(backend, request) {
  const method = request?.method ?? "";
  const handler = backend && typeof backend === "object" ? backend[method] : undefined;
  if (typeof handler !== "function") {
    throw new CuaHelperError(`Unknown broker method: ${method || "(empty)"}`, {
      code: "unrecognized_method",
    });
  }
  return okResponse(await handler(request.params, request));
}

export async function handleRequestLine(backend, line) {
  const request = parseRequestLine(line);
  if (!request) return errorResponse("Malformed broker request line", { code: "protocol" });
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
