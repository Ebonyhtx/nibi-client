/**
 * 假模块：形状与 `@trycua/cua-driver@0.62.1` 的 daemon 相关面一致。
 *
 * 只用于离线验证引擎适配层的**接线**（daemon 优先 / 回退 / 收尾），不碰真实系统。
 * 与 fake-cua-driver.mjs 的区别：那个演进程内 SDK；这个额外提供
 * `EmbeddedCuaDriverHost` + `CuaDriver.connect`，用来验证 daemon 分支。
 */
export const state = {
  hostStarts: 0,
  hostStops: 0,
  connects: [],
  shutdowns: 0,
  toolCalls: [],
  failStart: false,
  daemonUnavailable: false,
  embeddedUnavailable: false,
  socketPath: "\\\\.\\pipe\\fake-cua-daemon",
};

export const uniffiInitAsync = async () => {};

export const DriverOptions = {
  create: (partial = {}) => ({ claudeCodeCompatibility: false, ...partial }),
};

function createDriver(surface) {
  return {
    isAvailable: () =>
      surface === "daemon" ? !state.daemonUnavailable : !state.embeddedUnavailable,
    metadata: async () => ({ driverVersion: "fake-daemon-1", embedded: surface === "embedded" }),
    async callTool(name, argsJson) {
      state.toolCalls.push({ name, args: JSON.parse(argsJson) });
      if (name === "get_agent_cursor_state") {
        return {
          isError: false,
          structuredJson: JSON.stringify({ enabled: surface === "daemon", position: null }),
          text: "ok",
        };
      }
      return { isError: false, text: `${name} ok` };
    },
    async listApps() {
      return { apps: [] };
    },
    async listWindows() {
      return { windows: [] };
    },
    async getWindowState() {
      return { elements: [] };
    },
    async shutdown() {
      state.shutdowns += 1;
    },
  };
}

export const CuaDriver = {
  create: () => createDriver("embedded"),
  connect: (socketPath) => {
    state.connects.push(socketPath);
    return createDriver("daemon");
  },
};

export const EmbeddedDriverHostOptions = {
  create: (partial = {}) => ({ ...partial }),
};

export const EmbeddedCuaDriverHost = {
  withOptions: () => ({
    async start() {
      state.hostStarts += 1;
      if (state.failStart) throw new Error("fake daemon failed to start");
      return {
        socketPath: state.socketPath,
        pid: 4242,
        generation: "gen-1",
        driverVersion: "fake-daemon-1",
        contractVersion: "fake",
        mcpProtocolVersion: "fake",
        mcp: { command: "fake", args: [], environment: [] },
      };
    },
    async stop() {
      state.hostStops += 1;
    },
  }),
};
