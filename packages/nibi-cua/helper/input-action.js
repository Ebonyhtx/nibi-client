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
 * 交付模式默认 **foreground**（上游产品策略 background=false；真机 2026-10-11 实证：
 * background=UIA Invoke 对后台/挂起的 WinUI 窗口是空转——四次派发"成功"显示纹丝不动）。
 *
 * 从 helper/main.js 拆出（2026-10-13）：该文件曾达 562 有效行 > oxlint 上限 400。
 */

import { assertEngineOk } from "./observation.js";

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
 */
export function createInputAction({ semantics, engine, resolvePid, assertOk = assertEngineOk }) {
  return (method, run) =>
    async (params) => {
      semantics.assertKillSwitchAllows(method);
      semantics.acquireInputLease(method, sessionOf(params));
      try {
        const resolved = {
          ...(params ?? {}),
          delivery_mode: params?.delivery_mode === "background" ? "background" : "foreground",
        };
        if (typeof resolved.pid !== "number") {
          const pid = await resolvePid(resolved);
          if (typeof pid === "number") resolved.pid = pid;
        }
        const result = assertOk(await run(resolved, engine), method);
        return {
          ...(result ?? {}),
          action_sent: true,
          dispatch_status: "sent",
          // 回执带交付模式：runtime 靠它判"后台交付无效时给升级提示"（见 runtime/index.js）。
          delivery_mode: resolved.delivery_mode,
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
      }
    };
}
