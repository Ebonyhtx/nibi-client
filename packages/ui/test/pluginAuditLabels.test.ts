import { describe, expect, it } from "vitest";
import {
  resolvePluginAuditCapabilityLabelId,
  resolvePluginAuditTypeLabelId,
} from "../src/settings/pluginStoreListing.js";
import { formatAuditTime } from "../src/settings/PluginAuditList.js";

describe("插件审计文案映射", () => {
  it("已知事件类型映射到各自文案", () => {
    expect(resolvePluginAuditTypeLabelId("capability_invoked")).toBe(
      "settings.plugins.audit.type.capabilityInvoked",
    );
    expect(resolvePluginAuditTypeLabelId("capability_denied")).toBe(
      "settings.plugins.audit.type.capabilityDenied",
    );
    expect(resolvePluginAuditTypeLabelId("consent_granted")).toBe(
      "settings.plugins.audit.type.consentGranted",
    );
    expect(resolvePluginAuditTypeLabelId("grants_revoked")).toBe(
      "settings.plugins.audit.type.grantsRevoked",
    );
  });

  it("未知类型不映射（调用方原样显示 type，不显示成空白）", () => {
    expect(resolvePluginAuditTypeLabelId("future_event")).toBeUndefined();
    expect(resolvePluginAuditTypeLabelId("")).toBeUndefined();
  });

  it("五项能力都有可读文案，未知能力原样显示", () => {
    for (const capability of [
      "nibi.sessions.read",
      "nibi.workspace.files.read",
      "nibi.ui.view",
      "nibi.settings.own",
      "nibi.notifications.show",
    ]) {
      expect(resolvePluginAuditCapabilityLabelId(capability)).toBeTruthy();
    }
    expect(resolvePluginAuditCapabilityLabelId("nibi.future.capability")).toBeUndefined();
  });
});

describe("审计时间格式", () => {
  it("格式化为可读的日期时间（不含秒）", () => {
    const formatted = formatAuditTime("2026-11-25T14:22:33.000Z", "zh-CN");
    // 与运行机器时区无关的断言：只检查包含年月与时间分隔，不锁死具体时区偏移。
    expect(formatted).toMatch(/2026/u);
    expect(formatted).toMatch(/\d{1,2}:\d{2}/u);
    expect(formatted).not.toMatch(/:33/u);
  });

  it("无法解析时原样返回，不显示 Invalid Date", () => {
    expect(formatAuditTime("not-a-date", "zh-CN")).toBe("not-a-date");
  });
});
