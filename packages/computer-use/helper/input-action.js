/**
 * 输入类动作的统一包装：kill switch → 输入租约 → 调引擎 → 回执。
 *
 * 为什么要统一包装：这一层承载三条**跨会话不变式**，任何一条漏在一个动作上都会造成
 * 难以复现的故障，所以不允许各动作自己拼：
 *   1. kill switch 闩锁后一律拒绝（`assertKillSwitchAllows`）；
 *   2. 输入控制器是互斥资源——动作前必须拿租约（`acquireInputLease`），否则两个会话
 *      同时输入会交错；
 *   3. 回执必须带 `action_sent` / `dispatch_status`：**已下发但结果不明**时标
 *      `possibly_sent`（调用方只许先观察再决定，绝不自动重放——重放可能重复下单/重复删除）。
 *
 * 交付模式默认 **background**（2026-11-14 策略调整）：引擎 0.47.23 的 click/type_text/
 * press_key/scroll/drag/set_value/hotkey 都把 `background` 当作 mandatory first attempt，
 * 只有调用方显式升级或菜单路径才用 `foreground`——foreground 会短暂 SetForegroundWindow
 * 再 SendInput，既抢用户焦点又会闪。App 不响应后台输入时引擎会明确返回
 * `background_unavailable`（而不是假装成功），由调用方显式带 `delivery_mode:"foreground"`
 * 重试；我们绝不自动重试（点击是否落地不确定，重放可能双触发）。
 *
 * 从 helper/main.js 拆出（2026-10-13）：该文件曾达 562 有效行 > oxlint 上限 400。
 */

import { assertEngineOk } from "./observation.js";

/** 菜单路径（"文件(F) > 新建" / "File->New"）需要展开菜单，允许显式升级前台。 */
const MENU_PATH_PATTERN = /[>›»]|->/;

/**
 * 解析本次动作实际使用的交付模式。只接受两个值（其余 fail-closed），默认 background。
 * 菜单路径是唯一的自动升级：引擎文档说 invoke_menu 的 background 在"只能通过展开菜单
 * 才够得着"时会拒绝，因此这里按菜单动作的语义显式给 foreground；调用方仍可用
 * `delivery_mode:"background"` 覆盖，让引擎按它的判据拒绝（仍保持 fail-closed）。
 */
export function resolveDeliveryMode(method, params) {
  const requested = params?.delivery_mode;
  if (requested !== undefined && requested !== null) {
    if (requested !== "background" && requested !== "foreground") {
      throw Object.assign(new Error('delivery_mode 只能是 "background" 或 "foreground"'), {
        code: "unrecognized_keys",
      });
    }
    return requested;
  }
  if (method === "perform_action" && MENU_PATH_PATTERN.test(String(params?.action ?? ""))) {
    return "foreground";
  }
  return "background";
}

/** 从 params 取会话 id（租约按会话隔离）。 */
export function sessionOf(params) {
  return params && typeof params === "object" && typeof params.session_id === "string"
    ? params.session_id
    : null;
}

/**
 * 输入类动作的包装器工厂。
 *
 * @param {object} deps
 * @param {object} deps.semantics   Helper 语义（kill switch + 租约）
 * @param {object} deps.engine      引擎
 * @param {(params: object) => Promise<number|undefined>} deps.resolvePid
 * @param {(result: unknown, action: string) => unknown} [deps.assertOk] 默认 assertEngineOk
 * @param {object} [deps.activity] 活动上报器（`{active(method, params)}`）；纯展示旁路
 */
export function createInputAction({
  semantics,
  engine,
  resolvePid,
  assertOk = assertEngineOk,
  activity,
}) {
  return (method, run) =>
    async (params) => {
      semantics.assertKillSwitchAllows(method);
      // 先校验交付模式再拿租约：非法值不能留下一个"已占用"的输入权。
      const deliveryMode = resolveDeliveryMode(method, params);
      semantics.acquireInputLease(method, sessionOf(params));
      let activityStarted = false;
      try {
        const resolved = {
          ...(params ?? {}),
          delivery_mode: deliveryMode,
        };
        if (typeof resolved.pid !== "number") {
          const pid = await resolvePid(resolved);
          if (typeof pid === "number") resolved.pid = pid;
        }
        // 只在实际下发前上报活动：kill switch / 租约 / pid 解析失败都不该点亮"正在操作"。
        // 上报器自身 fail-open；这里再包一层，确保展示旁路永远不会截断动作。
        try {
          activity?.active?.(method, resolved);
          activityStarted = true;
        } catch {
          // cosmetic only
        }
        const result = assertOk(await run(resolved, engine), method);
        return {
          ...(result ?? {}),
          action_sent: true,
          dispatch_status: "sent",
          // 回执带交付模式：runtime 靠它判"后台交付无效时给升级提示"（见 runtime/index.js）。
          delivery_mode: deliveryMode,
        };
      } catch (error) {
        // 已下发但结果不明 → possibly_sent（调用方只许先观察再决定，绝不自动重放）。
        if (error?.code === "CUA_DISPATCH_AMBIGUOUS") {
          return {
            action_sent: true,
            dispatch_status: "possibly_sent",
            message: `${error.message ?? "动作结果不明"}；动作可能已下发，请先观察再决定`,
          };
        }
        throw error;
      } finally {
        // 工具调用结束（无论成功/失败）才开始 1.5s 空闲计时；上报器自身 fail-open。
        if (activityStarted) {
          try {
            activity?.settled?.();
          } catch {
            // cosmetic only
          }
        }
      }
    };
}
