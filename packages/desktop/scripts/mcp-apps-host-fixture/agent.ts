import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NibiProtocolClient } from "../../../services/src/zcode-agent/nibiProtocolClient.js";
import { ZCodeStdioTransport } from "../../../services/src/zcode-agent/zcodeStdioTransport.js";

// 夹具是测试进程：未捕获异常不能落到 Electron 的默认错误框上。强制结束 agent 或被取消的运行时
// 会让控制 socket 报 ECONNRESET，以前这会弹一个“A JavaScript error occurred in the main process”
// 对话框，打断运营者的桌面。这里只记录并以 1 退出（测试进程本来就该失败退出）。
process.on("uncaughtException", (error) => {
  const code = (error as NodeJS.ErrnoException)?.code;
  // 强杀 agent/页面时 Windows 的管道或控制 socket 会抛 ECONNRESET/EPIPE；测试进程忽略即可，
  // 不能让一个收尾期的 socket 重置中断整条链路。
  if (code === "ECONNRESET" || code === "EPIPE") {
    process.stderr.write(`[fixture] ignored uncaught ${code}\n`);
    return;
  }
  process.stderr.write(`[fixture] uncaught exception: ${error?.stack ?? String(error)}\n`);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[fixture] unhandled rejection: ${String(reason)}\n`);
});

export class Events<T> {
  readonly history: T[] = [];
  private waiters = new Set<{ match: (event: T) => boolean; resolve: (event: T) => void }>();
  emit(event: T) {
    this.history.push(event);
    for (const waiter of this.waiters)
      if (waiter.match(event)) {
        this.waiters.delete(waiter);
        waiter.resolve(event);
      }
  }
  wait(match: (event: T) => boolean, after = 0): Promise<T> {
    const existing = this.history.slice(after).find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => this.waiters.add({ match, resolve }));
  }
}
export async function startAgent(
  root: string,
  node: string,
  cli: string,
  providerEnv: Record<string, string> = {},
) {
  const events = new Events<any>();
  const approvals = new Events<any>();
  const notifications = new Events<any>();
  const sockets = new Map<string, Socket>();
  const connections = new Set<Socket>();
  const socketSources = new Map<Socket, string>();
  // Rust 内核（`--rust`）：同一个夹具改为拉起 `zcode-rs app-server --stdio`，MCP 服务器仍用 node。
  // Rust 的交互是 v4 `pendingInteractions` + `resolveInteraction`，不是 legacy 反向请求；下面把
  // pending 权限项归一成 legacy 形状，调用方（`r.params.input.key`）与 `respond` 都不用改。
  const rustBin = process.env.NIBI_MCP_E2E_RUST_BIN?.trim();
  if (process.env.NIBI_MCP_E2E_DEBUG) {
    setInterval(() => process.stderr.write("[fixture] beat\n"), 5_000);
  }
  let subscribedSession: string | null = null;
  let v4Revision = 0;
  const seenV4Permissions = new Set<string>();
  const acceptPendingInteractions = (pending: unknown, topic?: unknown) => {
    // 交互属于帧的会话主题，不是“最后订阅的那个”：第二个窗口（权限检查）订阅后，主窗口的
    // 询问若沿用全局 subscribedSession，应答会打到已销毁的会话上。
    const topicSession =
      typeof topic === "string" && topic.startsWith("conversation/")
        ? topic.slice("conversation/".length)
        : undefined;
    for (const item of Array.isArray(pending) ? pending : []) {
      const interactionId = item?.interactionId;
      if (typeof interactionId !== "string" || !interactionId || item.kind !== "permission") continue;
      if (seenV4Permissions.has(interactionId)) continue;
      seenV4Permissions.add(interactionId);
      approvals.emit({
        method: "interaction/requestPermission",
        params: {
          input: item.payload?.detail,
          toolName: item.payload?.toolName,
          summary: item.payload?.summary,
          // 与 legacy 反向请求同形的选项表（allowOnce/allowAlways/deny，Node 另有 allow_project）：
          // 检查按 optionId 找“项目级放行”，两个内核走同一条判断。
          options: item.payload?.options,
        },
        v4: {
          sessionId: topicSession ?? subscribedSession ?? "",
          interactionId,
          baseRevision: v4Revision,
        },
      });
    }
  };

  const control = createServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
    socket.on("error", (error) => {
      process.stderr.write(`[fixture] control socket error: ${error.message}\n`);
    });
    createInterface({ input: socket }).on("line", (line) => {
      const event = JSON.parse(line);
      socketSources.set(socket, event.source);
      sockets.set(event.source, socket);
      events.emit(event);
    });
    socket.on("close", () => {
      const source = socketSources.get(socket);
      socketSources.delete(socket);
      if (source && sockets.get(source) === socket) {
        const previous = [...socketSources]
          .reverse()
          .find(([candidate, key]) => key === source && !candidate.destroyed);
        if (previous) sockets.set(source, previous[0]);
        else sockets.delete(source);
      }
    });
  });
  await new Promise<void>((resolve) => control.listen(0, "127.0.0.1", resolve));
  control.on("error", (error) => {
    process.stderr.write(`[fixture] control server error: ${error.message}\n`);
  });
  const port = (control.address() as { port: number }).port;
  const data = join(root, "agent-data");
  await mkdir(data, { recursive: true });
  // Rust 没有 NIBI_PERSONAL_PROVIDER_CONFIG_FILE 的等价环境变量：把夹具的 personal provider
  // 配置放到它读的 `~/.nibi/v2/provider_config.json`（HOME/NIBI_DATA_BASE_DIR 都指到 data）。
  if (rustBin && providerEnv.NIBI_PERSONAL_PROVIDER_CONFIG_FILE) {
    const configDir = join(data, ".nibi", "v2");
    await mkdir(configDir, { recursive: true });
    await copyFile(
      providerEnv.NIBI_PERSONAL_PROVIDER_CONFIG_FILE,
      join(configDir, "provider_config.json"),
    );
  }
  // 不继承 API key、真实用户认证及 Electron Node 标志，模型测试也只通过显式传入的隔离配置访问本地 fixture。
  const child = spawn(rustBin || node, rustBin ? ["app-server", "--stdio"] : [cli, "app-server"], {
    cwd: data,
    env: {
      PATH: process.env.PATH,
      NIBI_DATA_BASE_DIR: data,
      NIBI_SESSION_DB: join(data, "session.sqlite"),
      NIBI_STORAGE_DIR: data,
      LANG: "en_US.UTF-8",
      ...(process.env.RUST_LOG ? { RUST_LOG: process.env.RUST_LOG } : {}),
      // 两个内核读同一组 NIBI_* 隔离根；Rust 的 `~` 展开仍要 HOME/USERPROFILE 指到夹具数据根。
      ...(rustBin ? { HOME: data, USERPROFILE: data } : {}),
      ...providerEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // 强杀 agent 时 Windows 的 stdio 管道也会报 ECONNRESET/EPIPE；不接住同样会变成
  // Electron 主进程的未捕获异常（弹窗）。这里是测试夹具，记录即可。
  for (const [stream, name] of [
    [child.stdin, "stdin"],
    [child.stdout, "stdout"],
    [child.stderr, "stderr"],
  ] as const) {
    stream?.on("error", (error) => {
      process.stderr.write(`[fixture] agent ${name} error: ${error.message}\n`);
    });
  }
  const transport = new ZCodeStdioTransport(child, {
    onStderrLine: (line) => process.stderr.write(line + "\n"),
  });
  const client = new NibiProtocolClient(transport, {
    requireStorageStartup: true,
    requestTimeoutMs: 15_000,
  });
  client.onNotification((event) => {
    notifications.emit(event);
    if (!rustBin || event.method !== "v4/conversation/frame") return;
    const payload = event.params?.frame?.payload;
    if (!payload) return;
    if (payload.kind === "snapshot") {
      v4Revision = payload.snapshot?.revision ?? v4Revision;
      acceptPendingInteractions(payload.snapshot?.pendingInteractions, event.params?.topic);
    } else if (payload.kind === "deltas") {
      for (const delta of payload.deltas ?? []) {
        if (delta?.op !== "state.updated" || !delta.patch) continue;
        if (Number.isFinite(delta.patch.revision)) v4Revision = delta.patch.revision;
        if (Array.isArray(delta.patch.pendingInteractions)) {
          acceptPendingInteractions(delta.patch.pendingInteractions, event.params?.topic);
        }
      }
    }
  });
  client.onRequest((request) => {
    if (request.method === "session/requestRuntimePreferences")
      void client.respond(request.id, {
        nativeSearchEnhancementsEnabled: false,
        memoryEnabled: false,
      });
    else if (request.method === "interaction/requestPermission") approvals.emit(request);
    else
      void client.respondError(request.id, -32601, `Unexpected fixture request: ${request.method}`);
  });
  // 真实编辑器的长轮询为 20 秒，不能套夹具普通 RPC 的 15 秒期限。
  const call = (method: string, params: unknown) => {
    if (process.env.NIBI_MCP_E2E_DEBUG) process.stderr.write(`[fixture] call ${method}\n`);
    const promise = client.request<any>(
      method as never,
      params,
      undefined,
      method === "mcp/uiCallTool" ? { timeoutMs: 180_000 } : undefined,
    );
    if (process.env.NIBI_MCP_E2E_DEBUG) {
      process.stderr.write(
        `[fixture] request-returned ${method} waiting=${client.storageStartup.isWaiting}\n`,
      );
      setTimeout(() => {
        process.stderr.write(
          `[fixture] pending ${method}: count=${client.pendingRequestCount} waiting=${client.storageStartup.isWaiting}\n`,
        );
      }, 10_000);
    }
    return promise;
  };
  // Rust 的询问只出现在 v4 帧里；先订阅会话主题，pendingInteractions 才有投递面。
  const subscribeV4 = async (sessionId: string) => {
    if (!rustBin) return;
    subscribedSession = sessionId;
    await call("v4/conversation/subscribe", {
      topic: `conversation/${sessionId}`,
      connectionId: "fixture",
      visibility: "foreground",
      clientMode: "desktop-continuous",
    });
  };
  const forceClose = () => {
    if (child.pid) {
      try {
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            detached: true,
            stdio: "ignore",
          });
          killer.unref();
        } else {
          process.kill(-child.pid, "SIGKILL");
        }
      } catch (error) {
        process.stderr.write(`[fixture] force close failed: ${String(error)}\n`);
      }
    }
    client.dispose();
    for (const socket of connections) socket.destroy();
  };
  return {
    call,
    client,
    events,
    approvals,
    notifications,
    respond: async (request: any, decision: "allow" | "deny") => {
      if (request?.v4) {
        await call("v4/command", {
          commandId: randomUUID(),
          clientId: "fixture",
          sessionId: request.v4.sessionId,
          type: "resolveInteraction",
          payload: {
            interactionId: request.v4.interactionId,
            answer: decision === "allow" ? { optionId: "allowOnce" } : { optionId: "deny" },
          },
          issuedAt: Date.now(),
        });
        return;
      }
      client.respond(request.id, { decision });
    },
    /// 按选项作答（检查里要“项目级放行”而不是 allowOnce）：legacy 回原 response，v4 回 optionId。
    respondOption: async (request: any, optionId: string) => {
      const option = request?.params?.options?.find(
        (candidate: any) => candidate.optionId === optionId,
      );
      if (!option) throw new Error(`permission option ${optionId} is not offered`);
      if (request?.v4) {
        await call("v4/command", {
          commandId: randomUUID(),
          clientId: "fixture",
          sessionId: request.v4.sessionId,
          type: "resolveInteraction",
          payload: {
            interactionId: request.v4.interactionId,
            answer: { optionId },
          },
          issuedAt: Date.now(),
        });
        return;
      }
      client.respond(request.id, option.response);
    },
    release: (source: string, key: string) =>
      sockets.get(source)!.write(JSON.stringify({ type: "release", key }) + "\n"),
    disconnect: (source: string) =>
      sockets.get(source)!.write(JSON.stringify({ type: "disconnect" }) + "\n"),
    notify: (source: string, uri: string) =>
      sockets.get(source)!.write(JSON.stringify({ type: "notify", uri }) + "\n"),
    async session(
      workspacePath: string,
      source: string,
      serverName = "fixture",
      workspaceIdentity?: string,
      demo?: { serverScript: string; resourceUri: string },
    ) {
      if (process.env.NIBI_MCP_E2E_DEBUG)
        process.stderr.write(`[fixture] session create start ${workspacePath}\n`);
      await mkdir(workspacePath, { recursive: true });
      if (process.env.NIBI_MCP_E2E_DEBUG) process.stderr.write("[fixture] workspace ready, sending\n");
      const workspace = {
        workspacePath,
        workspaceKey: workspaceIdentity ?? workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      };
      const response = await call("session/create", {
        workspace,
        mode: "build",
        persistence: "deferred",
        titleGenerationEnabled: false,
        mcpServers: [
          {
            name: serverName,
            command: node,
            args: demo
              ? [demo.serverScript]
              : [join(root, "mcp-server.mjs"), String(port), join(root, "widget.html"), source],
            env: [],
            protocolVersion: "legacy",
            isolation: "session",
          },
        ],
      });
      if (process.env.NIBI_MCP_E2E_DEBUG)
        process.stderr.write(`[fixture] created ${response.session.sessionId} (${serverName})\n`);
      const sessionId = response.session.sessionId;
      await subscribeV4(sessionId);
      return {
        workspace,
        sessionId,
        pluginId: "fixture",
        serverName,
        ...(demo ? { resourceUri: demo.resourceUri } : {}),
      };
    },
    async uiSession(
      workspacePath: string,
      source: string,
      demo?: { serverScript: string; resourceUri: string; surface: string },
    ) {
      const pluginRoot = join(workspacePath, "editor-plugin");
      await mkdir(join(pluginRoot, ".zcode-plugin"), { recursive: true });
      await writeFile(
        join(pluginRoot, ".zcode-plugin", "plugin.json"),
        JSON.stringify({
          name: "background-editor",
          mcpServers: {
            editor: {
              command: node,
              args: demo
                ? [demo.serverScript]
                : [join(root, "mcp-server.mjs"), String(port), join(root, "widget.html"), source],
            },
          },
        }),
      );
      await writeFile(
        join(workspacePath, "nibi.json"),
        JSON.stringify({ plugins: { dirs: [pluginRoot] } }),
      );
      const workspace = { workspacePath, workspaceKey: workspacePath };
      const response = await call("session/create", {
        workspace,
        mode: "yolo",
        persistence: "deferred",
        titleGenerationEnabled: false,
      });
      const sessionId = response.session.sessionId;
      await subscribeV4(sessionId);
      return {
        workspace,
        sessionId,
        pluginId: "background-editor@inline",
        serverName: "plugin:background-editor:editor",
        ...(demo ? { resourceUri: demo.resourceUri, surface: demo.surface } : {}),
      };
    },
    async close() {
      // 先走正常退出（stdin EOF），让会话库把 WAL 收尾；3 秒没退再按进程树强杀。
      // disposeAndWait 在这台机器上会卡在 CIM/stderr drain（Node 基线同样），夹具不用它。
      if (child.exitCode === null && child.signalCode === null) {
        child.stdin?.end();
        const exited = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 3_000);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve(true);
          });
        });
        if (!exited) forceClose();
      }
      client.dispose();
      for (const socket of connections) socket.destroy();
      await Promise.race([
        new Promise<void>((resolve) => control.close(() => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    },
    /// 不走 transport 的 CIM/快照收尾，直接按进程树强杀。
    forceClose,
  };
}
