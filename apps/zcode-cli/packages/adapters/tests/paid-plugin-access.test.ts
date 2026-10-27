import { describe, expect, it } from "vitest";
import {
  PaidPluginMembershipError,
  resolvePaidPluginAccessFromToken,
} from "../src/plugins/paid-plugin-access.js";

function refusalMessage(refusal: string): string {
  try {
    resolvePaidPluginAccessFromToken({ token: "", pluginName: "math-modeling", refusal });
  } catch (error) {
    if (error instanceof PaidPluginMembershipError) return error.message;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("paid plugin refusal reasons", () => {
  it("tells a first-time user they have not subscribed yet", () => {
    const message = refusalMessage("no_membership");
    expect(message).toContain("还没有开通");
    expect(message).not.toContain("暂停或撤销");
  });

  it("distinguishes an expired membership from a revoked one", () => {
    expect(refusalMessage("membership_expired")).toContain("已到期");
  });

  it("explains a device mismatch instead of claiming revocation", () => {
    expect(refusalMessage("device_mismatch")).toContain("设备");
  });

  it("explains a plan that does not cover the plugin", () => {
    expect(refusalMessage("not_entitled")).toContain("不包含该插件");
  });

  it("falls back to the revocation wording for unknown reasons", () => {
    expect(refusalMessage("some_new_server_reason")).toContain("暂停或撤销");
  });

  it("keeps the no-credential message when the device never activated", () => {
    try {
      resolvePaidPluginAccessFromToken({ token: "", pluginName: "math-modeling" });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(PaidPluginMembershipError);
      expect((error as PaidPluginMembershipError).reason).toBe("no_license");
      expect((error as Error).message).toContain("开通会员");
    }
  });
});
