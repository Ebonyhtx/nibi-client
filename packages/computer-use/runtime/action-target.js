/**
 * 动作目标解析：把 shim 的 `target` 参数解包成引擎要的显式字段，并绑定新鲜台账。
 *
 * 为什么要独立成模块：这里有**三条真机踩出来的**键名/优先级约定，任一条错了都会表现为
 * "点击全部被引擎打回"，而错误信息（"Provide element_token or (x, y)"）完全不指向真因：
 *   1. shim 的 `bindTarget` 产出 `{type:"element", index}` / `{type:"coordinate", frame_id, x, y}`
 *      —— 元素形态的键名是 **index**（只认 element_index 时索引点击全被拒）；
 *   2. `target` 的四种形态都要认：数字=元素索引、字符串=元素 token、[x,y]=坐标、对象见上；
 *   3. 坐标必须先有**新鲜帧**（显式 frame_id 要校验，否则隐式绑最新可动作帧），
 *      否则坐标落在过期帧上会点到错误的位置。
 *
 * 从 runtime/index.js 拆出（2026-10-13）：该文件曾达 401 有效行 > oxlint 上限 400。
 */

/**
 * 解包并校验动作目标。
 *
 * @param {object} ledger  会话台账（resolveElement / assertFrame / assertHasActionableFrame）
 * @param {object} params  原始工具参数
 * @returns {object} 解析后的参数（已删除 `target`）
 */
export function resolveActionTarget(ledger, params = {}) {
  const resolved = { ...params };
  const target = params.target;
  if (target !== undefined && target !== null) {
    if (typeof target === "number") {
      resolved.element_index = resolved.element_index ?? target;
    } else if (typeof target === "string" && target.trim()) {
      resolved.element_token = resolved.element_token ?? target.trim();
    } else if (Array.isArray(target) && target.length >= 2) {
      resolved.x = resolved.x ?? target[0];
      resolved.y = resolved.y ?? target[1];
    } else if (typeof target === "object") {
      resolved.element_index =
        resolved.element_index ?? target.element_index ?? target.elementIndex ?? target.index;
      resolved.element_token = resolved.element_token ?? target.element_token ?? target.token;
      resolved.x = resolved.x ?? target.x;
      resolved.y = resolved.y ?? target.y;
      resolved.frame_id = resolved.frame_id ?? target.frame_id ?? target.frameId;
    }
  }
  delete resolved.target;

  const index = resolved.element_index;
  if (index !== undefined) {
    const element = ledger.resolveElement(index);
    resolved.element_token = element.token ?? String(index);
    resolved.element_index = index;
  } else if (
    resolved.element_token === undefined &&
    resolved.x !== undefined &&
    resolved.y !== undefined
  ) {
    const frameId = params.frame_id ?? params.frameId;
    if (frameId !== undefined) ledger.assertFrame(String(frameId));
    else resolved.frame_id = ledger.assertHasActionableFrame();
  }
  return resolved;
}

/**
 * 从 params / target 里取出元素索引（perform_action 的入参校验用）。
 *
 * 为什么要单独一个函数：校验发生在 `resolveActionTarget` **之前**，而当时 `target` 还没解包
 * ——历史实现只读顶层 `params.element_index`，于是 SDK 发来的 `{target:{type:"element",index}}`
 * 被判成"缺元素"，把智能体逼去用低层 API（真机 2026-10-11 发现）。两处必须同口径。
 */
export function elementIndexOf(params = {}) {
  const direct = params.element_index ?? params.elementIndex;
  if (direct !== undefined) return direct;
  const target = params.target;
  if (typeof target === "number") return target;
  if (target && typeof target === "object") {
    return target.element_index ?? target.elementIndex ?? target.index;
  }
  return undefined;
}
