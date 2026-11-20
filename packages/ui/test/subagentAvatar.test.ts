import { describe, expect, it } from "vitest";
import {
  FACE_COLORS,
  agentColor,
  avatarColor,
} from "@/components/workflow-timeline/WorkflowAgentFace.js";
import { SUBAGENT_WORKFLOW_COLOR } from "@/lib/subagentColors.js";

// 子智能体头像的解析规则与上游同源：配置色经 SUBAGENT_WORKFLOW_COLOR 映射到
// WorkflowAgentFace 的九色板；没有配置色时退回名字散列 avatarColor(name)。
describe("subagent avatar resolution", () => {
  it("配置色映射到 workflow 九色板，与上游色值逐项一致", () => {
    expect(SUBAGENT_WORKFLOW_COLOR).toEqual({
      yellow: "#F19D38",
      red: "#EA4045",
      orange: "#ED712E",
      green: "#5BC67A",
      cyan: "#54B9A6",
      blue: "#3C82F6",
      purple: "#885CF5",
      pink: "#EB4699",
    });
    expect(SUBAGENT_WORKFLOW_COLOR).toEqual({
      yellow: FACE_COLORS[1],
      red: FACE_COLORS[8],
      orange: FACE_COLORS[5],
      green: FACE_COLORS[7],
      cyan: FACE_COLORS[0],
      blue: FACE_COLORS[4],
      purple: FACE_COLORS[3],
      pink: FACE_COLORS[6],
    });
  });

  it("内置子智能体没有配置色时按名称散列得到固定身份色", () => {
    // 与上游截图一致：general-purpose 蓝、Explore 绿（青）。
    expect(avatarColor("general-purpose")).toBe("#3C82F6");
    expect(avatarColor("Explore")).toBe("#54B9A6");
  });

  it("编号优先于名称散列，编号按九色环循环", () => {
    expect(agentColor(0, "general-purpose")).toBe(FACE_COLORS[0]);
    expect(agentColor(9, "Explore")).toBe(FACE_COLORS[0]);
    expect(agentColor(undefined, "Explore")).toBe(avatarColor("Explore"));
  });
});
