/**
 * `launch_app`：按名 / AUMID / 包名 / launch_path 拉起应用（透明拉起的后端）。
 *
 * 为什么要独立成模块：它是"防连开窗口"这条不变式的**两个实施点之一**（另一个在
 * transparent-activation 的级联里），而两者共用 activation-memory 的同一份冷却表——
 * 放一起才看得出"冷却键怎么取、冷却期返回什么"是一处约定，不是两处巧合。
 *
 * 关键事实（真机 2026-10-11 实测）：
 *   - `launch_path` 是 UWP 的正解：`shell:appsFolder\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`
 *     能拉起，且 launch_app 接受 pid=0 的注册条目；
 *   - 每次 launch 都可能**再开一个窗口**（用户实测"连开非常多个计算器"），
 *     所以同一目标 30s 内不再重复 launch；
 *   - 冷却期返回 `{launched:false, reason:"cooldown"}` —— 调用方仍应继续找窗口
 *     （应用多半已经在跑了），不要把它当失败。
 *
 * 从 helper/main.js 拆出（2026-10-13）：该文件曾达 576 有效行 > oxlint 上限 400。
 */

import { assertEngineOk } from "./observation.js";

/** 从 params 里取 launch 目标（四个字段任意组合，至少一个）。 */
export function parseLaunchTarget(params) {
  const input = params && typeof params === "object" ? params : {};
  const trimmed = (value) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const target = {
    name: trimmed(input.name),
    aumid: trimmed(input.aumid),
    bundleId: trimmed(input.bundle_id),
    launchPath: trimmed(input.launch_path),
  };
  if (!target.name && !target.aumid && !target.bundleId && !target.launchPath) {
    throw Object.assign(
      new Error("launch_app 需要 name / aumid / bundle_id / launch_path 之一"),
      { code: "unrecognized_keys" },
    );
  }
  // 冷却键：优先用最具体的标识（AUMID > bundle_id > launch_path > name），
  // 否则同一应用的不同写法会各自开一套冷却、防不住连开。
  target.cooldownKey = target.aumid ?? target.bundleId ?? target.launchPath ?? target.name;
  return target;
}

/**
 * 执行一次 launch（含冷却）。依赖注入以便单测：semantics / withinCooldown / rememberAttempt。
 */
export async function launchApp({ engine, params, semantics, withinCooldown, rememberAttempt }) {
  semantics.assertKillSwitchAllows("launch_app");
  const target = parseLaunchTarget(params);
  if (withinCooldown(target.cooldownKey)) {
    return { launched: false, reason: "cooldown" };
  }
  rememberAttempt(target.cooldownKey);
  const result = assertEngineOk(
    await engine.callTool("launch_app", {
      ...(target.name ? { name: target.name } : {}),
      ...(target.aumid ? { aumid: target.aumid } : {}),
      ...(target.bundleId ? { bundle_id: target.bundleId } : {}),
      ...(target.launchPath ? { launch_path: target.launchPath } : {}),
    }),
    "launch_app",
  );
  return { ...(result ?? {}), launched: true };
}
