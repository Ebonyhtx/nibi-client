/**
 * 透明激活：`get_app_state` 观察到的 UIA 树为空时，把目标窗口"弄活"再观察。
 *
 * 为什么要独立成模块：这是整个 Helper 里**行为约束最密**的一段——上游把"启动与激活"
 * 并进了 get_app_state，而真机踩过的坑几乎都落在这里：
 *   - UWP 窗口被遮挡/挂起时 UIA 树返回 0 元素（真机计算器实证）；
 *   - 每次 launch 都可能再开一个窗口（用户实测"连开非常多个计算器"）；
 *   - UWP 激活后窗口 id 会换（真身挂在 ApplicationFrameHost 下）。
 * 判据（防级联三件套，顺序不可换）：
 *   ① 激活记忆直切——旧窗→新窗，**不 launch**；
 *   ② 温和带前台（bring_to_front）——被遮挡通常这就够了，**不 launch**；
 *   ③ 按标题 launch——仅当前两步都没救回来，且**必须过冷却**，换窗必须记入映射。
 * 三条都是"只在树为空时"才走；正常观察绝不抢焦点。kill switch 闩锁后一律不激活。
 *
 * 从 helper/main.js 拆出（2026-10-13）：该文件曾达 562 有效行 > oxlint 上限 400，
 * 而这一段自成一类职责（"把窗口弄活"），拆出后既可单独测，也让主文件的协议派发更短。
 */

import { assertEngineOk, observeWindow, buildReceipt } from "./observation.js";
import {
  forgetWindowMove,
  lookupWindowMove,
  rememberLaunchAttempt,
  rememberWindowMove,
  withinLaunchCooldown,
} from "./activation-memory.js";

/** 激活后等待 UIA 树长出来的时间（测试可用环境变量压缩）。 */
export function activateSettle(multiplier = 1) {
  const raw = Number.parseInt(process.env.NIBI_CUA_ACTIVATE_SETTLE_MS ?? "600", 10);
  const ms = Number.isFinite(raw) && raw >= 0 ? raw : 600;
  return new Promise((resolve) => setTimeout(resolve, ms * multiplier));
}

/**
 * 树为空时尝试激活，成功则返回新的回执（并带 activated 标记）；失败返回原回执。
 *
 * @param {object} ctx
 * @param {object} ctx.engine      引擎（callTool / listWindows）
 * @param {object} ctx.semantics   Helper 语义（kill switch 判定）
 * @param {number} ctx.pid         目标窗口所属进程
 * @param {string|number} ctx.windowId
 * @param {object} ctx.input       原始 params（透传 include_screenshot 等）
 * @param {object} ctx.receipt     当前回执（元素为空）
 * @param {object} ctx.raw         当前原始观察结果
 * @param {() => Promise<object>} ctx.observeOnce 重新观察目标窗口
 */
export async function activateIfEmpty(ctx) {
  const { engine, semantics, pid, windowId, input } = ctx;
  let { receipt, raw } = ctx;

  const windowTitle =
    typeof raw?.windowTitle === "string" && raw.windowTitle.trim()
      ? raw.windowTitle.trim()
      : typeof raw?.title === "string"
        ? raw.title.trim()
        : "";
  const note = (line) => {
    receipt.text = `${receipt.text}\n[transparent-activation] ${line}`;
  };
  let settled = false;

  // ① 激活记忆：这个窗口之前被激活替换过 → 直接观察接替窗口，不碰 launch。
  const memoryHit = lookupWindowMove(windowId);
  if (memoryHit) {
    try {
      raw = await observeWindow(engine, memoryHit.pid, memoryHit.newId, input);
      const moved = buildReceipt(raw, semantics);
      if (moved.elements.length > 0) {
        receipt = moved;
        note(`该窗口此前已被激活替换，自动切到新窗口 ${memoryHit.newId} 观察`);
        settled = true;
      }
    } catch {
      // 接替窗口也没了（被关掉）：清掉旧映射，走下面的正常级联。
      forgetWindowMove(windowId);
    }
  }

  // ② 温和：把已有窗口带到前台。win32 应用被遮挡时通常这就够了。
  if (!settled) {
    try {
      await engine.callTool("bring_to_front", { pid, window_id: Number(windowId) });
      await activateSettle();
      raw = await ctx.observeOnce();
      receipt = buildReceipt(raw, semantics);
      if (receipt.elements.length > 0) {
        receipt.activated = true;
        note("元素树为空，已把窗口带到前台重新观察（这次结果来自激活后）");
        settled = true;
      }
    } catch {
      // 激活失败不吞观察。
    }
  }

  // ③ 按标题 launch_app（引擎自己解析显示名 → AUMID）。UWP 挂起时唯一有效路径，
  //    但每次 launch 都可能开新窗口——冷却期内绝不重复。
  if (!settled && windowTitle) {
    if (withinLaunchCooldown(windowTitle)) {
      note(
        "元素树为空；冷却期内已激活过「" +
          windowTitle +
          "」，不再重复激活以免连开窗口；可用 include_screenshot 走视觉路径，或稍后重试",
      );
    } else {
      try {
        rememberLaunchAttempt(windowTitle);
        assertEngineOk(await engine.callTool("launch_app", { name: windowTitle }), "launch_app");
        await activateSettle(3);
        // 先看原窗口活没活；再按标题在全窗口里找新窗口（UWP 真身挂在宿主进程下，id 会变）。
        raw = await ctx.observeOnce();
        receipt = buildReceipt(raw, semantics);
        if (receipt.elements.length === 0) {
          const all = await engine.listWindows({});
          const candidate = (all?.windows ?? []).find(
            (window) =>
              String(window.windowId ?? window.window_id) !== String(windowId) &&
              String(window.title ?? "").includes(windowTitle),
          );
          if (candidate) {
            const newWindowId = String(candidate.windowId ?? candidate.window_id);
            const newPid = typeof candidate.pid === "number" ? candidate.pid : pid;
            raw = await observeWindow(engine, newPid, newWindowId, input);
            receipt = buildReceipt(raw, semantics);
            if (receipt.elements.length > 0) {
              receipt.window = {
                window_id: newWindowId,
                ...(typeof newPid === "number" ? { pid: newPid } : {}),
                ...(candidate.title !== undefined ? { title: candidate.title } : {}),
              };
              rememberWindowMove(windowId, newWindowId, newPid);
            }
          }
        }
        if (receipt.elements.length > 0) {
          receipt.activated = true;
          const switched =
            receipt.window?.window_id !== undefined &&
            String(receipt.window.window_id) !== String(windowId)
              ? `（窗口已切换到 ${receipt.window.window_id}）`
              : "";
          note(`元素树为空，已按「${windowTitle}」激活应用后重新观察${switched}`);
          settled = true;
        }
      } catch {
        // 激活失败不吞观察。
      }
    }
  }

  if (!settled && receipt.elements.length === 0) {
    note("元素树为空，激活后仍为空——可用 include_screenshot 走视觉路径");
  }
  return receipt;
}
