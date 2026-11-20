/**
 * 透明激活假引擎：第一次 getWindowState 返回空树（模拟被遮挡/挂起的 UWP 窗口），
 * bring_to_front 之后的观察返回完整元素——用于钉死"空树 → 激活 → 重观察"的 helper 行为。
 */
let activated = false;

export const uniffiInitAsync = async () => {};

export const DriverOptions = {
  create: (partial = {}) => ({ claudeCodeCompatibility: false, ...partial }),
};

export const CuaDriver = {
  create: () => ({
    isAvailable: () => true,
    metadata: async () => ({ driverVersion: "fake-activate-0.0.0", contractVersion: "fake" }),
    listApps: async () => ({ apps: [{ pid: 1001, name: "LazyCalc", running: true, active: false }] }),
    listWindows: async () => ({
      windows: [
        {
          windowId: "771",
          pid: 1001,
          appName: "LazyCalc",
          title: "懒计算器",
          bounds: { x: 10, y: 10, width: 400, height: 300 },
          isOnScreen: true,
          zIndex: "1",
          layer: 0,
          minimized: false,
        },
      ],
    }),
    getWindowState: async () => ({
      windowId: "771",
      pid: 1001,
      appName: "LazyCalc",
      snapshotId: "snap-lazy-1",
      elements: activated
        ? [{ role: "Button", label: "六", elementToken: "s2:1", actions: ["invoke"] }]
        : [],
      text: "",
    }),
    callTool: async (name) => {
      if (name === "bring_to_front") {
        activated = true;
        return { isError: false, text: "brought to front" };
      }
      return { isError: false, text: "" };
    },
    shutdown: async () => {},
  }),
};
