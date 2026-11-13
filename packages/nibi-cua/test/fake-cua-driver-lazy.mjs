/**
 * 懒引擎假件：uniffiInitAsync 里按环境变量延迟/失败 —— 用来测
 * "transport_ready 先于引擎就绪"（冷启动竞态的回归测试）。
 *   FAKE_ENGINE_DELAY_MS  引擎"加载"耗时（默认 0）
 *   FAKE_ENGINE_FAIL=1    引擎加载抛错（helper 应先发 transport_ready 再报 error）
 */
const delayMs = Number.parseInt(process.env.FAKE_ENGINE_DELAY_MS ?? "0", 10) || 0;
const shouldFail = process.env.FAKE_ENGINE_FAIL === "1";

export const uniffiInitAsync = async () => {
  if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  if (shouldFail) throw new Error("FAKE_ENGINE_FAIL: 注入的加载失败");
};

export const DriverOptions = {
  create: (partial = {}) => ({ claudeCodeCompatibility: false, ...partial }),
};

export const CuaDriver = {
  create: () => ({
    isAvailable: () => true,
    metadata: async () => ({ driverVersion: "fake-lazy-0.0.0", contractVersion: "fake" }),
    listApps: async () => ({ apps: [{ pid: 4321, name: "LazyApp", running: true, active: true }] }),
    listWindows: async () => ({ windows: [] }),
    getWindowState: async () => ({}),
    callTool: async () => ({ isError: false, value: null }),
    shutdown: async () => {},
  }),
};
