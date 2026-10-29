import { describe, expect, it } from "vitest";
import {
  filterVisibleProviderTemplates,
  isProviderTemplateVisible,
} from "@/settings/model-provider-section/ProviderTemplatePicker.js";

function template(templateId: string, accessType: string) {
  return { templateId, config: { access: { type: accessType } } };
}

describe("provider template picker visibility", () => {
  it("hides the upstream subscription-plan templates", () => {
    // 服务端 builtin 快照里的真实 id 与访问类型（2026-10-29 缓存核对）。
    expect(
      isProviderTemplateVisible(template("zai-api", "zhipu-coding-plan-api-key")),
    ).toBe(false);
    expect(
      isProviderTemplateVisible(template("bigmodel-api", "zhipu-coding-plan-api-key")),
    ).toBe(false);
  });

  it("keeps the pay-as-you-go API templates of the same vendors", () => {
    expect(
      isProviderTemplateVisible(template("zai-standard-api", "api-key")),
    ).toBe(true);
    expect(
      isProviderTemplateVisible(template("bigmodel-standard-api", "api-key")),
    ).toBe(true);
  });

  it("keeps third-party providers and custom entries", () => {
    expect(isProviderTemplateVisible(template("deepseek", "api-key"))).toBe(true);
    expect(isProviderTemplateVisible(template("openai", "api-key"))).toBe(true);
  });

  it("filters the list without reordering", () => {
    const list = [
      template("zai-api", "zhipu-coding-plan-api-key"),
      template("deepseek", "api-key"),
      template("bigmodel-api", "zhipu-coding-plan-api-key"),
      template("kimi", "api-key"),
    ] as never;
    expect(
      (filterVisibleProviderTemplates(list) as unknown as { templateId: string }[]).map(
        (item) => item.templateId,
      ),
    ).toEqual(["deepseek", "kimi"]);
  });
});
