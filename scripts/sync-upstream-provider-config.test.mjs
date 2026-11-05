import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSyncedConfigs } from "./sync-upstream-provider-config.mjs";

function templateEntry(templateId, models, accessType = "api-key") {
  return {
    templateId,
    config: { access: { type: accessType }, builtinModelIds: models },
  };
}

function release({
  revision = 1,
  templates = [],
  templateModelRules = [],
  providerRules = [],
  providerSiteRules = [],
  builtinProviderModelRules = [],
}) {
  return {
    schemaVersion: 1,
    revision,
    config: {
      providerConfigRules: { templateRules: templates, providerRules },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules,
        templateModelRules,
        builtinProviderModelRules,
      },
    },
  };
}

test("follows upstream except ZAI/BigModel membership plans", () => {
  const currentProd = release({
    revision: 34,
    templates: [templateEntry("alpha", ["m1", "m2"])],
    templateModelRules: [{ templateId: "alpha", modelId: "m1", config: { enabled: true } }],
    providerSiteRules: [{ modelMatch: ".*", baseUrlMatch: "https://third.example" }],
  });
  const currentTest = release({
    revision: 34,
    templates: [templateEntry("alpha", ["m1", "m2"])],
    providerSiteRules: [
      { modelMatch: ".*", baseUrlMatch: "https://third.example" },
      { modelMatch: ".*", baseUrlMatch: "https://test-only.example" },
    ],
  });
  const upstream = release({
    revision: 43,
    templates: [
      templateEntry("alpha", ["m1", "m2", "m3"]),
      templateEntry("gamma", ["g1"]),
      templateEntry("kimi-code-cn", ["k1"]),
      templateEntry("zai-api", ["z1"], "zhipu-coding-plan-api-key"),
      templateEntry("bigmodel-api", ["b1"], "zhipu-coding-plan-api-key"),
    ],
    templateModelRules: [
      { templateId: "alpha", modelId: "m1", config: { enabled: false } },
      { templateId: "alpha", modelId: "m2", config: { enabled: true } },
      { templateId: "alpha", modelId: "m3", config: { enabled: true } },
      { templateId: "gamma", modelId: "g1", config: { enabled: true } },
      { templateId: "kimi-code-cn", modelId: "k1", config: { enabled: true } },
      { templateId: "zai-api", modelId: "z1", config: { enabled: true } },
    ],
    providerRules: [
      {
        providerId: "account:zai-individual-coding-plan",
        config: { access: { type: "zhipu-account", mode: "individual-coding-plan" } },
      },
      {
        providerId: "account:bigmodel-team-coding-plan",
        config: { access: { type: "zhipu-account", mode: "team-coding-plan" } },
      },
    ],
    providerSiteRules: [
      { modelMatch: ".*", baseUrlMatch: "https://third.example" },
      { modelMatch: ".*", baseUrlMatch: "https://api\\.z\\.ai/api/anthropic" },
      { modelMatch: ".*", baseUrlMatch: "https://zcode\\.z\\.ai/api/v1/zcode-plan" },
    ],
    builtinProviderModelRules: [
      { providerId: "account:zai-individual-coding-plan", modelId: "m1" },
      { providerId: "account:openai-team", modelId: "g1" },
    ],
  });

  const result = buildSyncedConfigs({ upstream, currentProd, currentTest });

  assert.equal(result.prod.revision, 35);
  assert.equal(result.test.revision, 35);
  // 上游模板全收，只有 ZAI/BigModel 的 coding-plan API-key 模板被排除。
  assert.deepEqual(result.templates.kept.sort(), ["alpha", "gamma", "kimi-code-cn"]);
  assert.deepEqual(result.templates.excluded.sort(), ["bigmodel-api", "zai-api"]);
  // 模型启停跟随上游：NIBI 原先把 m1 打开，这次改回上游的关闭。
  const alpha = result.prod.config.modelConfigRules.templateModelRules.filter(
    (rule) => rule.templateId === "alpha",
  );
  assert.deepEqual(
    alpha.map((rule) => [rule.modelId, rule.config.enabled]),
    [
      ["m1", false],
      ["m2", true],
      ["m3", true],
    ],
  );
  assert.equal(result.overridesDropped, 1);
  // Node 源不携带 providerRules；ZAI/BigModel 会员套餐规则不进 NIBI。
  assert.deepEqual(result.prod.config.providerConfigRules.providerRules, []);
  // 站点规则跟随上游，但去掉 zcode.z.ai 套餐站点。
  assert.deepEqual(
    result.prod.config.modelConfigRules.providerSiteRules.map((rule) => rule.baseUrlMatch),
    ["https://third.example", "https://api\\.z\\.ai/api/anthropic"],
  );
  // 会员套餐的 builtin 模型规则被过滤，普通 provider 规则保留。
  assert.deepEqual(result.prod.config.modelConfigRules.builtinProviderModelRules, [
    { providerId: "account:openai-team", modelId: "g1" },
  ]);
  // 测试专属站点规则只留在 test。
  assert.equal(
    result.test.config.modelConfigRules.providerSiteRules.some((rule) =>
      rule.baseUrlMatch.includes("test-only"),
    ),
    true,
  );
  assert.equal(
    result.prod.config.modelConfigRules.providerSiteRules.some((rule) =>
      rule.baseUrlMatch.includes("test-only"),
    ),
    false,
  );
});

test("reports a current template that upstream removed and drops it", () => {
  const currentProd = release({
    revision: 3,
    templates: [templateEntry("alpha", []), templateEntry("retired", [])],
  });
  const currentTest = release({ revision: 3, templates: [templateEntry("alpha", [])] });
  const upstream = release({ revision: 9, templates: [templateEntry("alpha", [])] });
  const result = buildSyncedConfigs({ upstream, currentProd, currentTest });
  assert.deepEqual(result.templates.kept, ["alpha"]);
  assert.deepEqual(result.templates.missingUpstream, ["retired"]);
});

test("rejects an invalid revision", () => {
  const currentProd = release({ revision: 3, templates: [templateEntry("alpha", [])] });
  const currentTest = release({ revision: 3, templates: [templateEntry("alpha", [])] });
  const upstream = release({ revision: 9, templates: [templateEntry("alpha", [])] });
  assert.throws(
    () => buildSyncedConfigs({ upstream, currentProd, currentTest, revision: 0 }),
    /invalid revision/u,
  );
});
