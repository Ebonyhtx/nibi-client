/**
 * UWP 挂起假引擎：窗口 771 的树**永远**为空（bring_to_front 救不活，真机实证），
 * launch_app 之后出现新窗口 999（真身挂在宿主进程下、window_id 会变）——
 * 钉死"二级激活：按标题 launch_app → 找新窗口 → 观察新窗口"的 helper 行为。
 */
let launched = false;

export const uniffiInitAsync = async () => {};

export const DriverOptions = {
  create: (partial = {}) => ({ claudeCodeCompatibility: false, ...partial }),
};

const WINDOW_771 = {
  windowId: "771",
  pid: 1001,
  appName: "LazyCalc.exe",
  title: "懒计算器",
  bounds: { x: 10, y: 10, width: 400, height: 300 },
  isOnScreen: true,
  zIndex: "1",
  layer: 0,
  minimized: false,
};
const WINDOW_999 = {
  windowId: "999",
  pid: 64992,
  appName: "AppHost.exe",
  title: "懒计算器",
  bounds: { x: 12, y: 14, width: 420, height: 320 },
  isOnScreen: true,
  zIndex: "2",
  layer: 0,
  minimized: false,
};

export const CuaDriver = {
  create: () => ({
    isAvailable: () => true,
    metadata: async () => ({ driverVersion: "fake-uwp-0.0.0", contractVersion: "fake" }),
    listApps: async () => ({ apps: [{ pid: 1001, name: "LazyCalc", running: true, active: false }] }),
    listWindows: async () => ({ windows: launched ? [WINDOW_771, WINDOW_999] : [WINDOW_771] }),
    getWindowState: async (input = {}) => {
      const windowId = String(input.windowId ?? "");
      const alive = windowId === "999" && launched;
      return {
        windowId,
        ...(typeof input.pid === "number" ? { pid: input.pid } : {}),
        appName: "LazyCalc.exe",
        windowTitle: "懒计算器",
        snapshotId: `snap-uwp-${windowId}`,
        elements: alive
          ? [{ role: "Button", label: "六", elementToken: "s9:1", actions: ["invoke"] }]
          : [],
        text: "",
      };
    },
    callTool: async (name) => {
      if (name === "bring_to_front") return { isError: false, text: "ok（但对挂起的 UWP 没用）" };
      if (name === "launch_app") {
        if (launched) {
          // 第二次 launch 必须不发生（冷却）——万一发生，这里直接失败让测试看见。
          return { isError: true, errorCode: "LAUNCH_TWICE", text: "第二次 launch 不该发生" };
        }
        launched = true;
        return { isError: false, text: "Launched LazyCalc_xxx!App (pid 64992) in background." };
      }
      return { isError: false, text: "" };
    },
    shutdown: async () => {},
  }),
};
