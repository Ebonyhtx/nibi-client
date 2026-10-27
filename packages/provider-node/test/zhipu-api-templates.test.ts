import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseZCodeBuiltinModelConfigRules } from "@nibi/provider";

describe("Zhipu standard API templates", () => {
  it.each(["nibi-builtin.json", "nibi-builtin.test.json"])(
    "%s 区分普通计费与套餐端点、签名准入、获取入口和媒体能力",
    async (filename) => {
      const release = JSON.parse(
        await readFile(new URL(`../../../config/provider/${filename}`, import.meta.url), "utf8"),
      );
      const templates = release.config.providerConfigRules.templateRules;
      for (const template of templates) {
        expect(
          new URL(template.config.access.apiKeyManagementUrl).protocol,
          template.templateId,
        ).toBe("https:");
        expect(template.config.access).not.toHaveProperty("teamApiKeyManagementUrl");
      }
      const rules = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules);
      for (const family of ["zai", "bigmodel"]) {
        for (const standard of [true]) {
          const templateId = `${family}-standard-api`;
          const template = templates.find(
            (item: { templateId: string }) => item.templateId === templateId,
          );
          expect(template, templateId).toBeDefined();
          const label = `${family === "zai" ? "Z.ai" : "BigModel"} API`;
          expect(template.templateNameMap).toEqual({ "zh-CN": label, "en-US": label });
          const config = template.config;
          const host = family === "zai" ? "api.z.ai" : "open.bigmodel.cn";
          expect(config.api).toEqual({
            type: "openai-chat-completions",
            baseUrl: `https://${host}/api/paas/v4`,
          });
          expect(config.access.type).toBe("api-key");
          expect(config.access.apiKeyManagementUrl).toBe(
            family === "zai"
              ? "https://z.ai/manage-apikey/apikey-list"
              : "https://bigmodel.cn/usercenter/proj-mgmt/apikeys",
          );
          for (const modelId of ["GLM-5.3", "GLM-5.3-Flash"]) {
            const resolved = rules.resolve({
              templateId,
              providerId: "personal-fixture",
              modelId,
              apiType: config.api.type,
              baseUrl: config.api.baseUrl,
            });
            expect(config.builtinModelIds).toContain(modelId);
            expect(resolved.enabled).toBe(true);
            expect(resolved.properties?.inputFormat?.supportsImage).toBe(modelId.endsWith("Flash"));
          }
        }
      }
    },
  );
});
