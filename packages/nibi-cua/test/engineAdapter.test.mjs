/**
 * 引擎适配层的怪癖判据（离线单元，不需要真引擎）。
 * 这些怪癖都来自真机实测，错一处回执语义就反向——钉死在测试里。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { normalizeToolResult } from "../engine/cua-driver.js";

test("引擎怪癖：S_OK(0x00000000) 被标 isError 时翻回成功（后台按键回执语义反向）", () => {
  const corrected = normalizeToolResult("key", {
    isError: true,
    text: "操作或完成。(0x00000000)",
    errorCode: "0x00000000",
  });
  assert.equal(corrected.isError, undefined, "S_OK 不是错误");
  assert.equal(corrected.errorCode, undefined);
  assert.equal(corrected.engineSokCorrected, true, "要留痕，便于诊断");

  // 文本里带 S_OK、errorCode 缺失的形态也要翻。
  const textOnly = normalizeToolResult("key", { isError: true, text: "操作或完成。(0x00000000)" });
  assert.equal(textOnly.isError, undefined);
  assert.equal(textOnly.engineSokCorrected, true);

  // 真拒绝（非零 HRESULT / 引擎错误码）保持失败语义，绝不能被误翻。
  const refused = normalizeToolResult("click", {
    isError: true,
    text: "元素不可用",
    errorCode: "0x80070005",
  });
  assert.equal(refused.isError, true);
  assert.equal(refused.engineSokCorrected, undefined);
});
