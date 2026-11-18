import { describe, expect, it } from "vitest";
import {
  resolveFallbackParameterView,
  resolveFallbackResultView,
  stringifyFallbackValue,
} from "@/ToolCallBlocks/renderers/fallbackModel.js";

describe("未知工具兜底卡数据", () => {
  it("全原始值对象展开为两列表格，嵌套对象整体回退原文", () => {
    expect(
      resolveFallbackParameterView({
        path: "/tmp/a.txt",
        count: 2,
        dryRun: false,
      }),
    ).toEqual({
      kind: "table",
      entries: [
        { key: "path", value: "/tmp/a.txt" },
        { key: "count", value: "2" },
        { key: "dryRun", value: "false" },
      ],
    });
    expect(
      resolveFallbackParameterView({ path: "/tmp/a.txt", options: { recursive: true } }),
    ).toEqual({
      kind: "raw",
      text: '{\n  "path": "/tmp/a.txt",\n  "options": {\n    "recursive": true\n  }\n}',
    });
  });

  it("无参数只覆盖 undefined 与空对象，数组/原始值/ null 都按原文展示", () => {
    expect(resolveFallbackParameterView(undefined)).toEqual({ kind: "none" });
    expect(resolveFallbackParameterView({})).toEqual({ kind: "none" });
    expect(resolveFallbackParameterView(["a", "b"])).toEqual({
      kind: "raw",
      text: '[\n  "a",\n  "b"\n]',
    });
    expect(resolveFallbackParameterView("hello")).toEqual({ kind: "raw", text: "hello" });
    expect(resolveFallbackParameterView(null)).toEqual({ kind: "raw", text: "null" });
  });

  it("错误优先于结果；错误没有文案时退回状态词，运行中无输出显示等待", () => {
    expect(
      resolveFallbackResultView({
        errorText: "boom",
        isRunning: true,
        output: "ignored",
        status: "failed",
      }),
    ).toEqual({ kind: "error", text: "boom", isString: true });
    expect(
      resolveFallbackResultView({
        errorText: undefined,
        isRunning: false,
        output: undefined,
        status: "failed",
        statusLabel: "Failed",
      }),
    ).toEqual({ kind: "error", text: "Failed", isString: true });
    expect(
      resolveFallbackResultView({
        isRunning: true,
        output: undefined,
        status: "in_progress",
      }),
    ).toEqual({ kind: "waiting", label: "result" });
    expect(
      resolveFallbackResultView({
        isRunning: false,
        output: undefined,
        status: "completed",
      }),
    ).toEqual({ kind: "empty", label: "result" });
  });

  it("保留 0/false 这类有效结果，复制文本使用同一序列化规则", () => {
    expect(
      resolveFallbackResultView({ isRunning: false, output: 0, status: "completed" }),
    ).toEqual({ kind: "result", text: "0", isString: false });
    expect(
      resolveFallbackResultView({ isRunning: false, output: false, status: "completed" }),
    ).toEqual({ kind: "result", text: "false", isString: false });
    expect(
      resolveFallbackResultView({ isRunning: false, output: { ok: true }, status: "completed" }),
    ).toEqual({ kind: "result", text: '{\n  "ok": true\n}', isString: false });
    expect(stringifyFallbackValue(undefined)).toBe("");
  });
});