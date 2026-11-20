/**
 * 回声假引擎：callTool 把收到的参数原样塞进 structuredJson 返回，
 * 用来判"产品层有没有把该传的字段传给引擎"（key 的 pid 透传等）。
 */
export const uniffiInitAsync = async () => {};

export const DriverOptions = {
  create: (partial = {}) => ({ claudeCodeCompatibility: false, ...partial }),
};

let bringToFrontCount = 0;

let launched = false;
const UWP_MODE = process.env.FAKE_UWP_MODE === "1";
export const FakeEchoState = {
  launchCalls: [],
  get launched() {
    return launched;
  },
  reset() {
    launched = false;
    FakeEchoState.launchCalls.length = 0;
  },
};

export const CuaDriver = {
  create: () => ({
    isAvailable: () => true,
    metadata: async () => ({ driverVersion: "fake-echo-0.0.0", contractVersion: "fake" }),
    listApps: async () =>
      UWP_MODE
        ? {
            apps: [
              {
                pid: 0,
                name: "Windows 记事本",
                bundle_id: "Microsoft.FakeNotepad_8wekyb3d8bbwe",
                running: false,
                kind: "uwp",
                launch_path:
                  "shell:appsFolder\Microsoft.FakeNotepad_8wekyb3d8bbwe!App",
              },
              {
                pid: 0,
                name: "Windows 默认锁屏界面",
                bundle_id: "Microsoft.LockApp_cw5n1h2txyewy",
                running: false,
                kind: "uwp",
              },
            ],
          }
        : { apps: [{ pid: 1001, name: "EchoApp", running: true, active: true }] },
    listWindows: async () =>
      process.env.FAKE_UWP_SHELL_FRESH === "1"
        ? {
            windows: [
              { windowId: "6666", pid: 4242, appName: "LockApp.exe", title: "Windows 默认锁屏界面", isOnScreen: true },
            ],
          }
        : UWP_MODE && (launched || process.env.FAKE_UWP_ALREADY_RUNNING === "1")
        ? {
            windows: [
              { windowId: "9001", pid: 4242, appName: "ApplicationFrameHost.exe", title: "记事本", isOnScreen: true },
            ],
          }
        : {
            windows: [
              {
                windowId: "771",
                pid: 1001,
                appName: "EchoApp",
                title: "回声",
                bounds: { x: 10, y: 10, width: 400, height: 300 },
                isOnScreen: true,
                zIndex: "1",
                layer: 0,
                minimized: false,
              },
            ],
          },
    getWindowState: async (input = {}) => ({
      windowId: String(input.windowId ?? ""),
      ...(typeof input.pid === "number" ? { pid: input.pid } : {}),
      appName: "EchoApp",
      windowTitle: "回声",
      snapshotId: "snap-echo-1",
      windowBounds: { x: 47, y: 32, width: 1202, height: 934 },
      screenshotWidth: 1216,
      screenshotHeight: 941,
      elements: [
        { role: "text_input", label: "标题", value: "", elementToken: "se:1", actions: ["set_value"], frame: { x: 60, y: 70, w: 200, h: 30 } },
        { role: "button", label: "新建", elementToken: "se:2", actions: ["invoke"], frame: { x: 100, y: 80, w: 40, h: 30 } },
      ],
      text: "1  text_input 标题\n2  button 新建 actions=[invoke]",
    }),
    callTool: async (name, argsJson) => {
      if (name === "bring_to_front") bringToFrontCount += 1;
      if (name === "launch_app") {
        launched = true;
        FakeEchoState.launchCalls.push(JSON.parse(argsJson));
      }
      return {
        isError: false,
        text: "",
        structuredJson: JSON.stringify({
          echo: name,
          args: JSON.parse(argsJson),
          bring_to_front_calls: bringToFrontCount,
        }),
      };
    },
    shutdown: async () => {},
  }),
};
