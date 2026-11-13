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
    // Windows 全路径（引擎 schema 的 path；比 name 更能钉死要拉起的可执行文件）。
    path: trimmed(input.path),
  };
  if (!target.name && !target.aumid && !target.bundleId && !target.launchPath && !target.path) {
    throw Object.assign(
      new Error("launch_app 需要 name / aumid / bundle_id / launch_path / path 之一"),
      { code: "unrecognized_keys" },
    );
  }
  // 冷却键：优先用最具体的标识（AUMID > bundle_id > launch_path > path > name），
  // 否则同一应用的不同写法会各自开一套冷却、防不住连开。
  target.cooldownKey =
    target.aumid ?? target.bundleId ?? target.launchPath ?? target.path ?? target.name;
  return target;
}

/**
 * 执行一次 launch（含冷却）。依赖注入以便单测：semantics / withinCooldown / rememberAttempt。
 */
export async function launchApp({ engine, params, semantics, withinCooldown, rememberAttempt }) {
  semantics.assertKillSwitchAllows("launch_app");
  const target = parseLaunchTarget(params);
  const input = params && typeof params === "object" ? params : {};
  if (withinCooldown(target.cooldownKey)) {
    return { launched: false, reason: "cooldown" };
  }
  rememberAttempt(target.cooldownKey);
  // 默认**不激活**：引擎 0.47.23 的 launch_app 本身就用 SW_SHOWNOACTIVATE 启动
  // （docs："never brings the target to the foreground"），只有调用方显式传
  // `activate:true` 才在拉起后 bring_to_front。`start_minimized:true` 可进一步把窗口
  // 收进任务栏（UIA/后台派发仍可用；截图和 foreground 交付才需要恢复）。
  const wantsActivation = input.activate === true;
  const startMinimized =
    typeof input.start_minimized === "boolean" ? input.start_minimized : undefined;
  const result = assertEngineOk(
    await engine.callTool("launch_app", {
      ...(target.name ? { name: target.name } : {}),
      ...(target.aumid ? { aumid: target.aumid } : {}),
      ...(target.bundleId ? { bundle_id: target.bundleId } : {}),
      ...(target.launchPath ? { launch_path: target.launchPath } : {}),
      ...(target.path ? { path: target.path } : {}),
      ...(typeof startMinimized === "boolean"
        ? { start_minimized: startMinimized }
        : wantsActivation
          ? { start_minimized: false }
          : {}),
    }),
    "launch_app",
  ) ?? {};
  if (wantsActivation) {
    // 显式激活才碰前台。launch 本身已成功；激活失败不回滚、也不把 launched 改假，
    // 但必须在文本里如实留痕（否则调用方会以为 activate:true 一定生效）。
    const structured = result?.structured ?? {};
    const pid =
      typeof structured.pid === "number"
        ? structured.pid
        : typeof result?.pid === "number"
          ? result.pid
          : undefined;
    const firstWindow = Array.isArray(structured.windows) ? structured.windows[0] : undefined;
    const windowId = firstWindow?.window_id ?? firstWindow?.windowId;
    if (typeof pid === "number") {
      try {
        assertEngineOk(
          await engine.callTool("bring_to_front", {
            pid,
            ...(windowId !== undefined ? { window_id: Number(windowId) } : {}),
          }),
          "bring_to_front",
        );
      } catch (error) {
        result.text = `${result.text ?? ""}\n[activation] 显式激活失败：${error instanceof Error ? error.message : String(error)}`;
      }
    } else {
      result.text = `${result.text ?? ""}\n[activation] 显式激活失败：launch 结果里没有 pid`;
    }
  }
  return { ...(result ?? {}), launched: true };
}
