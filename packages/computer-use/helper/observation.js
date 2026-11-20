/**
 * 观察与回执：把引擎的原始返回翻成"回执"（Helper 对外的稳定形状）。
 *
 * 从 helper/main.js 拆出（2026-10-13）：这些是纯函数，且被 transparent-activation
 * 复用；放在这里避免两个模块互相 import 主文件（会成环）。
 */

import { normalizeObservation } from "./semantics.js";

/**
 * 引擎把"拒绝/失败"放在**返回值**里（`{isError:true, errorCode, text}`），不是抛异常。
 * 惨痛教训：把它当成功会让回执标成 dispatch_status:"sent" —— 正是"假装成功"。
 * 所以所有工具调用都必须过这道判据：拒绝一律抛出，由运行时翻成错误信封。
 */
export function assertEngineOk(result, action) {
  if (result && typeof result === "object" && result.isError === true) {
    const code = result.errorCode ?? result.code ?? "ENGINE_ERROR";
    const detail = typeof result.text === "string" ? result.text : "";
    throw Object.assign(new Error(`${action} 被引擎拒绝：${detail || code}`), { code });
  }
  return result;
}

/** 观察一个窗口并规范化。pid 必备（引擎动作与截图都要）。 */
export function observeWindow(engine, pid, windowId, input) {
  return engine.getWindowState({
    pid,
    windowId: BigInt(String(windowId)),
    includeAccessibilityTree: true,
    ...(input.include_screenshot === true ? { includeScreenshot: true } : {}),
  });
}

/** 把观察结果包成回执，并附上截图本体（信封层再转成 image 块，不进收据 JSON）。 */
export function buildReceipt(raw, semantics) {
  const receipt = normalizeObservation(raw, semantics.mintStateId());
  const image = Array.isArray(raw?.images) ? raw.images[0] : undefined;
  const imageData = image?.dataBase64 ?? image?.data_base64;
  return {
    ...receipt,
    ...(typeof imageData === "string" && imageData
      ? {
          screenshot: {
            mime_type: image.mimeType ?? image.mime_type ?? "image/png",
            data_base64: String(imageData),
          },
        }
      : {}),
  };
}
