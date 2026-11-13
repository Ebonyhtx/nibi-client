/**
 * 激活记忆（每个 Helper 进程一份）。
 *
 * 为什么需要它（真机 2026-10-11 用户实测"开了非常多个计算器"）：UWP 应用的窗口属于
 * ApplicationFrameHost.exe 而不是应用自己，激活后会**换成另一个窗口 id**。
 * 若不记住"旧窗口 → 激活后接替的新窗口"这层映射，每次观察空树都会以为"没起来"再
 * launch 一次，于是窗口级联。
 *
 * 两类记忆：
 *   - windowMoves：旧窗口 id → 激活后接替的新窗口（+ pid）。命中就直接切过去，绝不重复 launch。
 *   - launchAttempts：标题 → 上次 launch_app 时间。冷却期内不重复激活。
 *
 * 从 helper/main.js 拆出来（2026-10-13，该文件曾达 576 有效行 > oxlint 上限 400）：
 * 这一块与"协议派发"无关，是独立的纯状态模块，放这里也让两个 Map 的生命周期一目了然。
 */

export const ACTIVATION_MEMORY = {
  windowMoves: new Map(),
  launchAttempts: new Map(),
};

/** 记忆上限：够覆盖一次会话里用到的窗口即可，超了淘汰最早的。 */
export const ACTIVATION_MEMORY_CAP = 32;

function launchCooldownMs() {
  const raw = Number.parseInt(process.env.NIBI_CUA_LAUNCH_COOLDOWN_MS ?? "30000", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 30000;
}

/** 记下"旧窗口 → 新窗口"的接替关系（UWP 激活会换窗口 id）。 */
export function rememberWindowMove(oldWindowId, newWindowId, pid) {
  ACTIVATION_MEMORY.windowMoves.set(String(oldWindowId), {
    newId: String(newWindowId),
    pid,
    at: Date.now(),
  });
  while (ACTIVATION_MEMORY.windowMoves.size > ACTIVATION_MEMORY_CAP) {
    ACTIVATION_MEMORY.windowMoves.delete(ACTIVATION_MEMORY.windowMoves.keys().next().value);
  }
}

/** 查"这个旧窗口现在换成了谁"。 */
export function lookupWindowMove(windowId) {
  return ACTIVATION_MEMORY.windowMoves.get(String(windowId));
}

/** 忘掉一条窗口接替映射（接替窗口也没了时调用）。 */
export function forgetWindowMove(windowId) {
  ACTIVATION_MEMORY.windowMoves.delete(String(windowId));
}

/**
 * 冷却判定：同一标题在冷却期内不重复 launch（每次 launch 都会再开一个窗口）。
 * 返回 true 表示"刚试过，别再试"。
 */
export function withinLaunchCooldown(title, now = Date.now()) {
  const key = String(title ?? "").trim();
  if (!key) return false;
  const last = ACTIVATION_MEMORY.launchAttempts.get(key);
  if (typeof last !== "number") return false;
  return now - last < launchCooldownMs();
}

/** 记下一次 launch 尝试（用于冷却判定）。 */
export function rememberLaunchAttempt(title, now = Date.now()) {
  const key = String(title ?? "").trim();
  if (!key) return;
  ACTIVATION_MEMORY.launchAttempts.set(key, now);
  while (ACTIVATION_MEMORY.launchAttempts.size > ACTIVATION_MEMORY_CAP) {
    ACTIVATION_MEMORY.launchAttempts.delete(ACTIVATION_MEMORY.launchAttempts.keys().next().value);
  }
}
