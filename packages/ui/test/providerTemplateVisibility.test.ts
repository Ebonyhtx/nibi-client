import { describe, expect, it } from "vitest";
import {
  filterVisibleProviderTemplates,
  isProviderTemplateVisible,
} from "@/settings/model-provider-section/ProviderTemplatePicker.js";

function template(templateId: string, accessType: string) {
  return { templateId, config: { access: { type: accessType } } };
}

describe("provider template picker visibility", () => {
  it("keeps the coding-plan templates as ordinary third-party providers", () => {
    // Z.ai / BigModel Coding Plan 是用户自备 API Key 的模板，与 Kimi Code、Qwen 套餐同级。
    expect(isProviderTemplateVisible(template("zai-api", "zhipu-coding-plan-api-key"))).toBe(true);
    expect(isProviderTemplateVisible(template("bigmodel-api", "zhipu-coding-plan-api-key"))).toBe(
      true,
    );
  });

  it("keeps the pay-as-you-go API templates of the same vendors", () => {
    expect(isProviderTemplateVisible(template("zai-standard-api", "api-key"))).toBe(true);
    expect(isProviderTemplateVisible(template("bigmodel-standard-api", "api-key"))).toBe(true);
  });

  it("keeps third-party providers and custom entries", () => {
    expect(isProviderTemplateVisible(template("deepseek", "api-key"))).toBe(true);
    expect(isProviderTemplateVisible(template("openai", "api-key"))).toBe(true);
  });

  it("still hides account/membership templates", () => {
    expect(isProviderTemplateVisible(template("some-account-plan", "zhipu-account"))).toBe(false);
  });

  it("filters the list without reordering", () => {
    const list = [
      template("zai-api", "zhipu-coding-plan-api-key"),
      template("deepseek", "api-key"),
      template("bigmodel-api", "zhipu-coding-plan-api-key"),
      template("kimi", "api-key"),
      template("membership", "zhipu-account"),
    ] as never;
    expect(
      (filterVisibleProviderTemplates(list) as unknown as { templateId: string }[]).map(
        (item) => item.templateId,
      ),
    ).toEqual(["zai-api", "deepseek", "bigmodel-api", "kimi"]);
  });
});
