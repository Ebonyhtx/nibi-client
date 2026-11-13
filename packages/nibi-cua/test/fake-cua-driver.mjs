/**
 * 假引擎：形状与 `@trycua/cua-driver` 一致（CuaDriver.create() + 只读方法），
 * 供离线测试整条链路（helper → engine 适配 → broker 协议 → 客户端）。
 * 数据是写死的样例，不含任何真实系统调用。
 */
export const FakeDriverState = { calls: [], frameSeq: 0 };

export const SAMPLE_APPS = [
  { pid: 1001, name: "Notes", bundle_id: "com.fake.notes", running: true, active: true, kind: "desktop" },
  { pid: 1002, name: "Calculator", bundle_id: "com.fake.calc", running: true, active: false, kind: "desktop" },
];

export const SAMPLE_WINDOWS = [
  {
    windowId: "771",
    pid: 1001,
    appName: "Notes",
    title: "备忘录",
    bounds: { x: 100, y: 120, width: 800, height: 600 },
    isOnScreen: true,
    zIndex: "3",
    layer: 0,
    minimized: false,
  },
];

export const uniffiInitAsync = async () => {};

export const DriverOptions = {
  create: (partial = {}) => ({ claudeCodeCompatibility: false, ...partial }),
};

export const CuaDriver = {
  create: () => ({
    isAvailable: () => true,
    executionMode: () => 0,
    socketPath: () => "",
    metadata: async () => ({
      driverVersion: "fake-0.0.0",
      contractVersion: "fake",
      toolsListSchemaVersion: "1",
      capabilityVersion: "1",
      mcpProtocolVersion: "2025-06-18",
      pid: process.pid,
      embedded: true,
    }),
    listApps: async () => ({ apps: SAMPLE_APPS }),
    listWindows: async (input = {}) => ({
      windows:
        typeof input.pid === "number"
          ? SAMPLE_WINDOWS.filter((window) => window.pid === input.pid)
          : SAMPLE_WINDOWS,
    }),
    getWindowState: async (input = {}) => ({
      windowId: String(input.windowId ?? ""),
      ...(typeof input.pid === "number" ? { pid: input.pid } : {}),
      appName: "Notes",
      snapshotId: `snap-${FakeDriverState.frameSeq += 1}`,
      ...(input.includeScreenshot === true
        ? {
            frame_id: `frame-${FakeDriverState.frameSeq += 1}`,
            screenshotWidth: 800,
            screenshotHeight: 600,
            images: [{ mimeType: "image/png", dataBase64: "ZmFrZS1wbmc=" }],
          }
        : {}),
      title: "备忘录",
      bounds: SAMPLE_WINDOWS[0].bounds,
      elements: [
        { index: 1, kind: "text_input", name: "标题", value: "", editable: true },
        { index: 2, kind: "button", name: "新建", actions: ["AXPress"] },
      ],
      text: "1  text_input 标题\n2  button 新建 actions=[AXPress]",
    }),
    callTool: async (name, argsJson) => {
      const args = JSON.parse(argsJson || "{}");
      if (process.env.FAKE_CUA_AMBIGUOUS_TOOL === name) {
        throw Object.assign(new Error("模拟：响应丢失"), { code: "CUA_DISPATCH_AMBIGUOUS" });
      }
      FakeDriverState.calls.push({ name, args });
      return {
        text: `${name} ok`,
        structuredJson: JSON.stringify({ tool: name, args }),
        isError: false,
        degraded: false,
      };
    },
    shutdown: async () => {},
  }),
};
