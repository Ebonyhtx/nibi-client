/**
 * 给插件 SDK 看的 MCP 结果信封（形状由客户端真实解析逻辑决定，见 IMPLEMENTATION.md §二）。
 *
 * 四条形态，别混：
 *   成功（观察）＝ 树文本块 + 结构化收据（structuredContent 与文本块各一份，客户端两个都会读）
 *   成功（动作）＝ 只有结构化收据
 *   错误        ＝ `isError:true` + 一个文本块装 `{code, message, details?}`
 *   冷启动      ＝ **非错误**信封 + `kind:"CUA_NOT_READY"`（SDK 按退避重试；retryable:false 时绝不重放）
 */

function textBlock(text) {
  return { type: "text", text };
}

function receiptText(receipt) {
  return JSON.stringify(receipt, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
}

/**
 * 观察：树给人看，收据给 SDK 抠 state_id/elements。
 * 截图本体以 MCP image 块走 content 一次（SDK 的 imageBytesOf 只认
 * `{type:"image", data}`）；base64 绝不进收据——收据会以 JSON 文本块重复出现。
 */
export function observationEnvelope(receipt, imageRef, screenshot) {
  const data = typeof screenshot?.data_base64 === "string" ? screenshot.data_base64 : undefined;
  return {
    content: [
      textBlock(receipt.text ?? ""),
      textBlock(receiptText(receipt)),
      // image_ref 四键固定块（规格 §3.2）：带截图时另发一块，SDK 靠它把坐标动作绑到帧上。
      ...(imageRef ? [textBlock(receiptText(imageRef))] : []),
      ...(data
        ? [
            {
              type: "image",
              data,
              mimeType: typeof screenshot.mime_type === "string" ? screenshot.mime_type : "image/png",
            },
          ]
        : []),
    ],
    structuredContent: receipt,
  };
}

/** 动作：只回收据（action_sent / dispatch_status / state_sync_status / effect_evidence）。 */
export function receiptEnvelope(receipt) {
  return { content: [textBlock(receiptText(receipt))], structuredContent: receipt };
}

/** 错误：isError + `{code, message, details}`（details 必须带，owner 之类靠它说清）。 */
export function errorEnvelope(code, message, details) {
  return {
    isError: true,
    content: [textBlock(receiptText({ code, message, ...(details === undefined ? {} : { details }) }))],
  };
}

/** 冷启动：不是错误。`retryable:false` 专用于 possibly_sent，避免把"可能已落地"当可重试。 */
export function notReadyEnvelope(reasonCode, { retryable = true, message } = {}) {
  return {
    content: [
      textBlock(
        receiptText({
          kind: "CUA_NOT_READY",
          reasonCode,
          retryable,
          message: message ?? "Computer Use 正在启动，稍后原样重试同一调用。",
        }),
      ),
    ],
  };
}

/** 把运行时自己的异常统一翻译成错误信封。 */
export function envelopeFromError(error) {
  const code = typeof error?.code === "string" && error.code ? error.code : "INTERNAL";
  const message = error instanceof Error ? error.message : String(error);
  return errorEnvelope(code, message, error?.details);
}
