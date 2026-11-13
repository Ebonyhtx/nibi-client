import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

import { WindowsCuaHelperHost } from "#src/cua-permission-broker/windowsCuaDevHelperHost.js";
import {
  CONTROL_PROTOCOL,
  parseCuaActivityMessage,
} from "#src/cua-permission-broker/windowsCuaHelperHostSupport.js";

class FakeChild extends EventEmitter {
  readonly pid = 4242;
  readonly sent: unknown[] = [];

  send(message: unknown): boolean {
    this.sent.push(message);
    return true;
  }

  kill(): boolean {
    setImmediate(() => this.emit("exit", 0));
    return true;
  }
}

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const runtime = {
  root: "C:\\cua-helper",
  entryPath: "C:\\cua-helper\\helper\\main.js",
  addonPath: "C:\\cua-helper\\addon.node",
  command: "electron.exe",
  commandEnv: {},
};

function activityMessage(overrides: Record<string, unknown> = {}) {
  return {
    protocol: CONTROL_PROTOCOL,
    type: "cua_activity",
    active: true,
    sessionId: "sess-1",
    action: "left_click",
    x: 120,
    y: 240,
    at: 1_700_000_000_000,
    ...overrides,
  };
}

describe("parseCuaActivityMessage", () => {
  it("接受完整的活动消息", () => {
    expect(parseCuaActivityMessage(activityMessage())).toEqual({
      active: true,
      sessionId: "sess-1",
      action: "left_click",
      x: 120,
      y: 240,
      at: 1_700_000_000_000,
    });
  });

  it("坐标必须成对；单个坐标不猜", () => {
    const parsed = parseCuaActivityMessage(activityMessage({ y: undefined }));
    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("x");
    expect(parsed).not.toHaveProperty("y");
  });

  it("inactive 允许 sessionId=null", () => {
    expect(
      parseCuaActivityMessage(
        activityMessage({
          active: false,
          sessionId: null,
          action: "idle",
          x: undefined,
          y: undefined,
        }),
      ),
    ).toEqual({
      active: false,
      sessionId: null,
      action: "idle",
      at: 1_700_000_000_000,
    });
  });

  it("畸形/非活动消息一律忽略（不得让 generation 失败）", () => {
    expect(parseCuaActivityMessage(activityMessage({ active: "yes" }))).toBeNull();
    expect(parseCuaActivityMessage(activityMessage({ at: "now" }))).toBeNull();
    expect(parseCuaActivityMessage(activityMessage({ action: "" }))).toBeNull();
    expect(parseCuaActivityMessage({ ...activityMessage(), protocol: "other/v1" })).toBeNull();
    expect(parseCuaActivityMessage({ ...activityMessage(), type: "ready" })).toBeNull();
  });
});

describe("WindowsCuaHelperHost activity forwarding", () => {
  async function startHost(onCuaActivity: (event: unknown) => void, child = new FakeChild()) {
    const host = new WindowsCuaHelperHost({
      runtime,
      childProcess: { fork: () => child },
      mintSocketPath: () => "\\\\.\\pipe\\nibi-cua-activity-test",
      mintPluginAuthority: () => "authority",
      healthProbe: async () => ({ pid: child.pid, bundleId: "test.bundle" }),
      startupTimeoutMs: 1_000,
      shutdownTimeoutMs: 10,
      logger: silentLogger as never,
      onCuaActivity,
    });
    const started = host.start();
    // start() 经 lifecycle tail 排队，等它真正 fork 并挂上 listener。
    await vi.waitFor(() => expect(child.listenerCount("message")).toBeGreaterThan(0));
    child.emit("message", {
      protocol: CONTROL_PROTOCOL,
      type: "transport_ready",
      socketPath: "\\\\.\\pipe\\nibi-cua-activity-test",
      pid: child.pid,
    });
    child.emit("message", {
      protocol: CONTROL_PROTOCOL,
      type: "ready",
      socketPath: "\\\\.\\pipe\\nibi-cua-activity-test",
      pid: child.pid,
    });
    await started;
    return { host, child };
  }

  it("转发已校验活动；回调抛错不影响 Host 与后续消息", async () => {
    const seen: unknown[] = [];
    const { host, child } = await startHost((event) => {
      seen.push(event);
      throw new Error("display layer exploded");
    });
    try {
      child.emit("message", activityMessage());
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ action: "left_click", sessionId: "sess-1" });
      // 畸形活动被忽略，Host 仍在运行。
      child.emit("message", activityMessage({ active: "yes" }));
      expect(seen).toHaveLength(1);
      expect(host.running).toBe(true);
      // 后续合法活动仍能转发。
      child.emit("message", activityMessage({ action: "type", active: false }));
      expect(seen).toHaveLength(2);
    } finally {
      await host.stop();
    }
  });
});
