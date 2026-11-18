// Host 端的反向 RPC：只接受 5 个白名单方法（4 个动作 + cancel），
// 校验信封与动作输入，把错误映射成 `{ok:false,error:{code,message}}`。
import { createHash } from "node:crypto";
import type {
  AppControlHostReply,
  AppControlRequestEnvelope,
  IAppControlReverseRpc,
} from "./contract.js";
import { APP_CONTROL_METHODS, APP_CONTROL_METHOD_NAMES, AppControlError } from "./contract.js";
import {
  cancelInputSchema,
  createTrustedContext,
  listProjectsInputSchema,
  openSessionInputSchema,
  parseEnvelope,
  sessionCreatedInputSchema,
  setSessionArchivedInputSchema,
  setSessionPinnedInputSchema,
} from "./context.js";
import type { AppControlService } from "./index.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_RECEIPTS = 4096;

export interface AppControlReverseRpcDependencies {
  service: AppControlService;
  /** 单个动作的 Host 侧上限；内核同样在 60s 超时。 */
  timeoutMs?: number;
  logWarn?: (message: string, error?: unknown) => void;
}

interface Receipt {
  fingerprint: string;
  result: unknown;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function replyError(error: unknown): AppControlHostReply {
  if (error instanceof AppControlError) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  if (error instanceof Error && error.name === "ZodError") {
    return { ok: false, error: { code: "invalid_input", message: error.message } };
  }
  return {
    ok: false,
    error: {
      code: "unavailable",
      message: error instanceof Error ? error.message : "App control request failed",
    },
  };
}

export function createAppControlReverseRpc(
  deps: AppControlReverseRpcDependencies,
): IAppControlReverseRpc {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pending = new Map<string, AbortController>();
  const receipts = new Map<string, Receipt>();

  function callKey(envelope: AppControlRequestEnvelope): string {
    return `${envelope.callerSessionId}\u0000${envelope.callId}`;
  }

  function remember(
    envelope: AppControlRequestEnvelope,
    requestId: string,
    action: string,
    input: unknown,
    run: () => Promise<unknown>,
  ): Promise<unknown> {
    const key = `${envelope.callerSessionId}\u0000${requestId}`;
    const fingerprint = digest([action, input]);
    const previous = receipts.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        throw new AppControlError("conflict", "requestId already belongs to a different request");
      }
      return Promise.resolve(previous.result);
    }
    return run().then((result) => {
      if (receipts.size >= MAX_RECEIPTS) {
        // 容量满时保留旧回执（仍可对账），新请求按 unavailable 拒绝，不淘汰仍可重放的记录。
        throw new AppControlError(
          "unavailable",
          "App control receipt capacity reached; existing receipts remain queryable",
        );
      }
      receipts.set(key, { fingerprint, result });
      return result;
    });
  }

  return {
    async handle(method, params) {
      try {
        if (!APP_CONTROL_METHOD_NAMES.has(method)) {
          throw new AppControlError("invalid_input", `Unsupported App control method: ${method}`);
        }
        const envelope = parseEnvelope(params);
        if (method === APP_CONTROL_METHODS.cancel) {
          cancelInputSchema.parse(envelope.input);
          const controller = pending.get(callKey(envelope));
          controller?.abort();
          pending.delete(callKey(envelope));
          return { ok: true, result: {} };
        }
        if (method === APP_CONTROL_METHODS.sessionCreated) {
          // 内核直接建出会话后的单向通知：不要求目标已在 Host 目录里（它正是来补这一行的），
          // 但仍只接受当前连接的信封与工作区；失败只记 warning，不回传业务错误。
          const input = sessionCreatedInputSchema.parse(envelope.input);
          await deps.service.noteSessionCreated({
            sessionId: input.sessionId,
            workspacePath: envelope.workspacePath,
            ...(envelope.workspaceIdentity
              ? { workspaceIdentity: envelope.workspaceIdentity }
              : {}),
          });
          return { ok: true, result: {} };
        }

        const controller = new AbortController();
        const key = callKey(envelope);
        pending.set(key, controller);
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const scopes = await deps.service.discovery.listScopes();
          const trusted = createTrustedContext(envelope, scopes.scopes);
          let result: unknown;
          switch (method) {
            case APP_CONTROL_METHODS.listProjects: {
              const input = listProjectsInputSchema.parse(envelope.input);
              result = await deps.service.listProjects(trusted, input);
              break;
            }
            case APP_CONTROL_METHODS.openSession: {
              const input = openSessionInputSchema.parse(envelope.input);
              result = await deps.service.openSession(trusted, input, controller.signal);
              break;
            }
            case APP_CONTROL_METHODS.setSessionArchived: {
              const input = setSessionArchivedInputSchema.parse(envelope.input);
              result = await remember(envelope, input.requestId, method, input, () =>
                deps.service.setSessionArchived(trusted, input, controller.signal),
              );
              break;
            }
            case APP_CONTROL_METHODS.setSessionPinned: {
              const input = setSessionPinnedInputSchema.parse(envelope.input);
              result = await remember(envelope, input.requestId, method, input, () =>
                deps.service.setSessionPinned(trusted, input, controller.signal),
              );
              break;
            }
            default:
              throw new AppControlError("invalid_input", `Unsupported method: ${method}`);
          }
          return { ok: true, result };
        } finally {
          clearTimeout(timer);
          pending.delete(key);
        }
      } catch (error) {
        deps.logWarn?.("app-control: reverse request failed", error);
        return replyError(error);
      }
    },
  };
}