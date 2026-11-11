import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type {
  ConnectionProfile,
  RemoteTarget,
  ServerRemoteInfo,
  SourceServerConnectionStateSnapshot,
} from "@nibi/shared";
import type { IServiceAccessor } from "@nibi/services";
import type { SourceServerTransportAdapter } from "@nibi/server/source-server";
import { SourceServerConnectionManager } from "../src/host/sourceServerConnectionManager.js";

const profileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";
const sourceServerId = "3cd4f9da-cd79-426c-9d70-75f36e9f6a87";
const target: RemoteTarget = { kind: "docker", container: "nibi-dev" };
const profile: ConnectionProfile = {
  profileId,
  sourceServerId,
  transport: "docker",
  target,
  createdAt: 1,
};
const serverInfo: ServerRemoteInfo = {
  serverId: sourceServerId,
  version: "3.8.0",
  protocolVersion: 1,
  authRequired: true,
  workspaces: [],
  compatibility: {
    schemaVersion: 1,
    productVersion: "3.8.0",
    minCompatibleVersion: "3.8.0",
  },
  identity: { osUser: "alice", hostname: "devbox" },
  migration: { failedPathCount: 0 },
  capabilities: { desktopContinuous: true, websocketRpc: true },
};

function createAdapter(): SourceServerTransportAdapter {
  return {
    kind: "docker",
    probe: vi.fn(async () => ({
      platform: "linux",
      arch: "x64",
      installed: true,
      installedVersion: "3.8.0",
    })),
    installOrUpdate: vi.fn(async () => undefined),
    ensureDaemon: vi.fn(async () => ({ port: 43123, ingressToken: "token" })),
    openChannel: vi.fn(async () => new PassThrough()),
    exec: vi.fn(),
    createFileTransfer: vi.fn(() => ({ exec: vi.fn(), upload: vi.fn(async () => undefined) })),
  };
}

function createOnlineConnection(onClose?: (event: { reason: string }) => void): {
  serverInfo: ServerRemoteInfo;
  services: IServiceAccessor;
  dispose: () => void;
} {
  return {
    serverInfo,
    services: {} as IServiceAccessor,
    dispose: vi.fn(() => onClose?.({ reason: "disposed" })),
  };
}

function lifecycleManager(options: {
  adapter: SourceServerTransportAdapter;
  connectServer: ReturnType<typeof vi.fn>;
}): SourceServerConnectionManager {
  return new SourceServerConnectionManager({
    directory: { recordHandshake: vi.fn().mockResolvedValue({ identityChanged: false }) },
    createAdapter: () => options.adapter,
    connectServer: options.connectServer,
    compatibilityManifest: serverInfo.compatibility!,
  });
}

const route = { profile, target };

describe("SourceServerConnectionManager remote service lifecycle", () => {
  it("disconnects before stop, sends stop --wait, and never schedules a retry", async () => {
    const adapter = createAdapter();
    let closeOnline: ((event: { reason: string }) => void) | undefined;
    const dispose = vi.fn();
    const connectServer = vi.fn(async (input: { onClose?: typeof closeOnline }) => {
      closeOnline = input.onClose;
      return {
        serverInfo,
        services: {} as IServiceAccessor,
        dispose,
      };
    });
    (adapter.exec as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      // 远端服务退出会让在线连接关闭；此时恢复意图已删除，不得排重试或离线探测。
      closeOnline?.({ reason: "remote service stopped" });
      return {
        exitCode: 0,
        stdout: JSON.stringify({ state: "stopped" }),
        stderr: "",
      };
    });
    const manager = lifecycleManager({ adapter, connectServer });
    const states: SourceServerConnectionStateSnapshot[] = [];
    manager.onDidChangeState((state) => states.push(state));
    try {
      await manager.connect({ profile, target });
      expect(manager.getOnlineConnection(sourceServerId)).toBeDefined();

      await manager.stopSource({ sourceServerId, resolveOfflineRoute: async () => route });

      expect(adapter.exec).toHaveBeenCalledWith(
        target,
        ["stop", "--wait", "--json"],
        expect.anything(),
      );
      expect(dispose).toHaveBeenCalledOnce();
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "offline",
        sourceServerId,
      });
      expect(states.some((state) => state.state === "retrying")).toBe(false);
      expect(manager.getOnlineConnection(sourceServerId)).toBeUndefined();
    } finally {
      manager.dispose();
    }
  });

  it("keeps the device offline and exposes the stop failure code", async () => {
    const adapter = createAdapter();
    (adapter.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 1,
      stdout: JSON.stringify({
        ok: false,
        code: "source-server-stop-failed",
        error: "core did not terminate",
        retryable: true,
      }),
      stderr: "",
    });
    const manager = lifecycleManager({
      adapter,
      connectServer: vi.fn(async () => createOnlineConnection()),
    });
    try {
      await manager.connect({ profile, target });
      await expect(
        manager.stopSource({ sourceServerId, resolveOfflineRoute: async () => route }),
      ).rejects.toMatchObject({ code: "source-server-stop-failed" });
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "offline",
        sourceServerId,
        errorCode: "source-server-stop-failed",
        retryable: true,
      });
      expect(manager.getOnlineConnection(sourceServerId)).toBeUndefined();
    } finally {
      manager.dispose();
    }
  });

  it("treats the online close during restart as expected and reconnects", async () => {
    const adapter = createAdapter();
    let closeOnline: ((event: { reason: string }) => void) | undefined;
    let connectionCount = 0;
    const connectServer = vi.fn(async (input: { onClose?: typeof closeOnline }) => {
      closeOnline = input.onClose;
      connectionCount += 1;
      return createOnlineConnection();
    });
    (adapter.exec as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      closeOnline?.({ reason: "remote service restarting" });
      return {
        exitCode: 0,
        stdout: JSON.stringify({ state: "ready", pid: 99 }),
        stderr: "",
      };
    });
    const manager = lifecycleManager({ adapter, connectServer });
    const invalidated: Array<{ reason: string }> = [];
    const reconnected = vi.fn();
    const states: SourceServerConnectionStateSnapshot[] = [];
    manager.onDidInvalidateConnection((event) => invalidated.push(event));
    manager.onDidReconnect(reconnected);
    manager.onDidChangeState((state) => states.push(state));
    try {
      await manager.connect({ profile, target });
      expect(connectionCount).toBe(1);

      await manager.restartSource({ sourceServerId, resolveOfflineRoute: async () => route });

      expect(adapter.exec).toHaveBeenCalledWith(target, ["restart", "--json"], expect.anything());
      expect(invalidated).toContainEqual({ sourceServerId, reason: "restart" });
      expect(states.some((state) => state.state === "retrying")).toBe(false);
      expect(states.some((state) => state.state === "bootstrapping")).toBe(true);
      expect(connectionCount).toBe(2);
      expect(reconnected).toHaveBeenCalledOnce();
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "online",
        sourceServerId,
      });
    } finally {
      manager.dispose();
    }
  });

  it("settles a failed restart from an offline device as a connection failure", async () => {
    const adapter = createAdapter();
    (adapter.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 1,
      stdout: JSON.stringify({
        ok: false,
        code: "source-server-control-unresponsive",
        error: "supervisor did not answer",
      }),
      stderr: "",
    });
    const manager = lifecycleManager({
      adapter,
      connectServer: vi.fn(async () => createOnlineConnection()),
    });
    try {
      // 从未连接状态发起：没有恢复意图，失败必须是“连接失败”而不是中性的未连接。
      await expect(
        manager.restartSource({ sourceServerId, resolveOfflineRoute: async () => route }),
      ).rejects.toMatchObject({ code: "source-server-control-unresponsive" });
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "failed",
        sourceServerId,
        errorCode: "source-server-control-unresponsive",
        retryable: true,
      });
    } finally {
      manager.dispose();
    }
  });

  it("keeps automatic recovery after a failed restart that still has a recovery intent", async () => {
    const adapter = createAdapter();
    let closeOnline: ((event: { reason: string }) => void) | undefined;
    const connectServer = vi.fn(async (input: { onClose?: typeof closeOnline }) => {
      closeOnline = input.onClose;
      return createOnlineConnection();
    });
    (adapter.exec as ReturnType<typeof vi.fn>).mockResolvedValue({
      exitCode: 1,
      stdout: JSON.stringify({ ok: false, error: "restart failed" }),
      stderr: "",
    });
    const manager = lifecycleManager({ adapter, connectServer });
    try {
      await manager.connect({ profile, target });
      // 意外断线建立恢复意图（retrying），重启失败必须从第一档继续恢复。
      closeOnline?.({ reason: "socket closed" });
      expect(manager.getStateByProfile(profileId)).toMatchObject({ state: "retrying" });

      await expect(
        manager.restartSource({ sourceServerId, resolveOfflineRoute: async () => route }),
      ).rejects.toThrow(/restart failed/);
      expect(manager.getStateByProfile(profileId)).toMatchObject({
        state: "retrying",
        sourceServerId,
        recoveryAttempt: 1,
      });
    } finally {
      manager.dispose();
    }
  });

  it("rejects stop and restart while an update flight owns the device", async () => {
    const adapter = createAdapter();
    let finishInstall!: () => void;
    (adapter.installOrUpdate as ReturnType<typeof vi.fn>).mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          finishInstall = resolve;
        }),
    );
    const manager = lifecycleManager({
      adapter,
      connectServer: vi.fn(async () => createOnlineConnection()),
    });
    try {
      const update = manager.updateServer({
        profile,
        target,
        release: {
          localArchivePath: "/tmp/nibi.tar.gz",
          target: "linux-x64",
          version: "3.8.0",
          sha256: "a".repeat(64),
          sizeBytes: 1,
          urls: [],
        },
      });
      await vi.waitFor(() => expect(adapter.installOrUpdate).toHaveBeenCalledOnce());
      await expect(
        manager.restartSource({ sourceServerId, resolveOfflineRoute: async () => route }),
      ).rejects.toMatchObject({ code: "source-server-operation-in-progress", retryable: true });
      await expect(
        manager.stopSource({ sourceServerId, resolveOfflineRoute: async () => route }),
      ).rejects.toMatchObject({ code: "source-server-operation-in-progress" });
      finishInstall();
      await update;
    } finally {
      manager.dispose();
    }
  });

  it("returns a running-task list or marks it unavailable", async () => {
    const adapter = createAdapter();
    const manager = lifecycleManager({
      adapter,
      connectServer: vi.fn(async () => createOnlineConnection()),
    });
    try {
      const exec = adapter.exec as ReturnType<typeof vi.fn>;
      exec.mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify([{ sessionId: "session-1", workspacePath: "/work/app" }]),
        stderr: "",
      });
      await expect(
        manager.getSourceRunningTasks({
          sourceServerId,
          resolveOfflineRoute: async () => route,
        }),
      ).resolves.toEqual({
        available: true,
        tasks: [{ sessionId: "session-1", workspacePath: "/work/app" }],
      });

      exec.mockResolvedValueOnce({ exitCode: 0, stdout: "null", stderr: "" });
      await expect(
        manager.getSourceRunningTasks({
          sourceServerId,
          resolveOfflineRoute: async () => route,
        }),
      ).resolves.toEqual({ available: false });

      exec.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "no supervisor" });
      await expect(
        manager.getSourceRunningTasks({
          sourceServerId,
          resolveOfflineRoute: async () => route,
        }),
      ).resolves.toEqual({ available: false });
    } finally {
      manager.dispose();
    }
  });

  it("propagates credentials-required instead of pretending there are no tasks", async () => {
    const adapter = createAdapter();
    const manager = lifecycleManager({
      adapter,
      connectServer: vi.fn(async () => createOnlineConnection()),
    });
    try {
      await expect(
        manager.getSourceRunningTasks({
          sourceServerId,
          resolveOfflineRoute: async () => {
            throw Object.assign(new Error("interactive credentials required"), {
              code: "credentials-required",
            });
          },
        }),
      ).rejects.toMatchObject({ code: "credentials-required" });
    } finally {
      manager.dispose();
    }
  });
});
