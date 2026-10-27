// 云端项目协作的宿主 broker：agent 侧 MCP 工具（project_*）→ 本机 HTTP → IProjectSyncService。
//
// 为什么需要这一层：
//   - 模型能调的工具在插件 MCP 进程里，而 NIBI access token 只在宿主；
//   - 直接给插件注入 access token 会破坏「令牌不进插件」的边界；
//   - 所以宿主只发一张**按工作区限定、短时有效**的能力令牌，broker 用它反查工作区，
//     再调用宿主已经持有的 IProjectSyncService。插件拿不到 NIBI token，也换不了工作区。
//
// 安全约束：
//   - 只监听 127.0.0.1（随机端口），POST /v1/project-sync 一个入口；
//   - Bearer 令牌随机 32 字节，默认 12 小时过期；
//   - upload/pull 的工作区取令牌绑定的那个，body 里的 workspace 只用于一致性校验；
//   - 不回传内部堆栈，不记录 token/请求体。
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { IProjectSyncService } from "../project-sync/projectSyncClient.js";

export const CLOUD_PROJECT_BROKER_URL_ENV = "NIBI_CLOUD_BROKER_URL";
export const CLOUD_PROJECT_BROKER_TOKEN_ENV = "NIBI_CLOUD_BROKER_TOKEN";

const PROJECT_SYNC_PATH = "/v1/project-sync";
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

export interface CloudProjectBroker {
  /** 给一次 agent spawn 发一份 broker 地址 + 工作区能力令牌。 */
  envForWorkspace(workspacePath: string): Promise<Record<string, string>>;
  dispose(): Promise<void>;
}

interface TokenScope {
  workspacePath: string;
  workspaceKey: string;
  expiresAt: number;
}

function workspaceKey(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function jsonResponse(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function fail(response: ServerResponse, status: number, code: string, message: string): void {
  jsonResponse(response, status, { ok: false, error: { code, message } });
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejectPromise(new Error("请求体过大"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolvePromise(text ? JSON.parse(text) : {});
      } catch (error) {
        rejectPromise(error);
      }
    });
    request.on("error", rejectPromise);
  });
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function createCloudProjectBroker(options: {
  projectSync: IProjectSyncService;
  tokenTtlMs?: number;
}): CloudProjectBroker {
  const tokenTtlMs = options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS;
  const tokens = new Map<string, TokenScope>();
  let server: Server | null = null;
  let starting: Promise<string> | null = null;
  let disposed = false;

  function prune(): void {
    const now = Date.now();
    for (const [token, scope] of tokens) {
      if (scope.expiresAt <= now) tokens.delete(token);
    }
  }

  async function ensureStarted(): Promise<string> {
    if (server) {
      const address = server.address();
      if (address && typeof address === "object") return `http://127.0.0.1:${address.port}`;
    }
    if (starting) return starting;
    if (disposed) throw new Error("cloud project broker 已释放");
    starting = new Promise<string>((resolvePromise, rejectPromise) => {
      const instance = createServer((request, response) => {
        void handle(request, response).catch(() => {
          if (!response.headersSent) fail(response, 500, "internal", "broker 处理失败");
        });
      });
      instance.once("error", (error) => {
        starting = null;
        rejectPromise(error);
      });
      instance.listen(0, "127.0.0.1", () => {
        server = instance;
        // 不把 broker 变成"应用退不出去"的句柄；真正关闭走 dispose。
        instance.unref();
        const address = instance.address();
        if (!address || typeof address !== "object") {
          rejectPromise(new Error("broker 没有拿到监听端口"));
          return;
        }
        resolvePromise(`http://127.0.0.1:${address.port}`);
      });
    });
    return starting;
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== "POST" || new URL(request.url ?? "/", "http://127.0.0.1").pathname !== PROJECT_SYNC_PATH) {
      fail(response, 404, "not_found", "未知的 broker 端点");
      return;
    }
    const authorization = request.headers.authorization ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const scope = token ? tokens.get(token) : undefined;
    if (!scope || scope.expiresAt <= Date.now()) {
      fail(response, 401, "unauthorized", "broker 令牌无效或已过期");
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch {
      fail(response, 400, "invalid_body", "请求体不是合法 JSON");
      return;
    }
    const payload = recordOf(body);
    if (!payload) {
      fail(response, 400, "invalid_body", "请求体必须是对象");
      return;
    }
    const action = textOf(payload.action, 32);
    const requestedWorkspace = textOf(payload.workspace, 4096);
    if (requestedWorkspace && workspaceKey(requestedWorkspace) !== scope.workspaceKey) {
      fail(response, 403, "workspace_mismatch", "工作区与 broker 令牌不匹配");
      return;
    }

    try {
      const result = await dispatch(action, payload, scope);
      jsonResponse(response, 200, { ok: true, result });
    } catch (error) {
      if (error instanceof BrokerInputError) {
        fail(response, 400, "invalid_params", error.message);
        return;
      }
      jsonResponse(response, 200, {
        ok: false,
        error: {
          code: "project_sync_failed",
          message: error instanceof Error ? error.message : "云端项目同步失败",
        },
      });
    }
  }

  async function dispatch(
    action: string,
    payload: Record<string, unknown>,
    scope: TokenScope,
  ): Promise<unknown> {
    switch (action) {
      case "list":
        return options.projectSync.listProjects();
      case "create": {
        const name = textOf(payload.name, 80);
        if (!name) throw new BrokerInputError("项目名必须是 1–80 个字符");
        return options.projectSync.createProject(name);
      }
      case "join": {
        const inviteCode = textOf(payload.inviteCode, 128);
        if (!inviteCode) throw new BrokerInputError("邀请码无效");
        return options.projectSync.joinProject(inviteCode);
      }
      case "status": {
        const projectId = textOf(payload.projectId, 128);
        if (!projectId) throw new BrokerInputError("projectId 无效");
        return options.projectSync.projectStatus(projectId);
      }
      case "version": {
        const projectId = textOf(payload.projectId, 128);
        const revision = Number(payload.revision);
        if (!projectId || !Number.isInteger(revision) || revision < 1) {
          throw new BrokerInputError("projectId 或 revision 无效");
        }
        return options.projectSync.getVersion(projectId, revision);
      }
      case "upload": {
        const projectId = textOf(payload.projectId, 128);
        if (!projectId) throw new BrokerInputError("projectId 无效");
        return options.projectSync.upload(
          scope.workspacePath,
          projectId,
          textOf(payload.message, 500),
        );
      }
      case "pull": {
        const projectId = textOf(payload.projectId, 128);
        if (!projectId) throw new BrokerInputError("projectId 无效");
        return options.projectSync.pull(scope.workspacePath, projectId);
      }
      default:
        throw new BrokerInputError(`未知的云端项目动作：${action || "(空)"}`);
    }
  }

  return {
    async envForWorkspace(workspacePath: string) {
      if (!workspacePath.trim()) throw new Error("缺少工作区路径");
      const url = await ensureStarted();
      prune();
      const token = randomBytes(32).toString("hex");
      tokens.set(token, {
        workspacePath: resolve(workspacePath),
        workspaceKey: workspaceKey(workspacePath),
        expiresAt: Date.now() + tokenTtlMs,
      });
      return {
        [CLOUD_PROJECT_BROKER_URL_ENV]: url,
        [CLOUD_PROJECT_BROKER_TOKEN_ENV]: token,
      };
    },
    async dispose() {
      disposed = true;
      tokens.clear();
      const instance = server;
      server = null;
      starting = null;
      if (!instance) return;
      instance.closeAllConnections?.();
      await new Promise<void>((resolvePromise) => instance.close(() => resolvePromise()));
    },
  };
}

class BrokerInputError extends Error {}
