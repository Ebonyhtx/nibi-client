import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSyncedConfigs } from "./sync-upstream-provider-config.mjs";

function release({ revision = 1, templates = [], templateModelRules = [], providerSiteRules = [], builtinProviderModelRules = [] }) {
  return {
    schemaVersion: 1,
    revision,
    config: {
      providerConfigRules: {
        templateRules: templates.map((templateId) => ({
          templateId,
          config: { builtinModelIds: [] },
        })),
        providerRules: [],
      },
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

function template(releaseValue, templateId, models) {
  const entry = releaseValue.config.providerConfigRules.templateRules.find(
    (rule) => rule.templateId === templateId,
  );
  entry.config.builtinModelIds = models;
}

test("keeps NIBI's template allowlist, model overrides and site rules", () => {
  const currentProd = release({
    revision: 34,
    templates: ["alpha", "beta"],
    templateModelRules: [
      { templateId: "alpha", modelId: "m1", config: { enabled: true } },
      { templateId: "alpha", modelId: "m2", config: { enabled: true } },
      { templateId: "alpha", modelId: "gone", config: { enabled: true } },
      { templateId: "beta", modelId: "b1", config: { enabled: false } },
    ],
    providerSiteRules: [{ modelMatch: ".*", baseUrlMatch: "https://third.example" }],
  });
  template(currentProd, "alpha", ["m1", "m2"]);
  template(currentProd, "beta", ["b1"]);

  const currentTest = release({
    revision: 34,
    templates: ["alpha", "beta"],
    providerSiteRules: [
      { modelMatch: ".*", baseUrlMatch: "https://third.example" },
      { modelMatch: ".*", baseUrlMatch: "https://test-only.example" },
    ],
  });

  const upstream = release({
    revision: 43,
    templates: ["alpha", "beta", "gamma"],
    templateModelRules: [
      { templateId: "alpha", modelId: "m1", config: { enabled: false } },
      { templateId: "alpha", modelId: "m2", config: { enabled: false } },
      { templateId: "alpha", modelId: "m3", config: { enabled: true } },
      { templateId: "gamma", modelId: "g1", config: { enabled: true } },
    ],
    providerSiteRules: [
      { modelMatch: ".*", baseUrlMatch: "https://third.example" },
      { modelMatch: ".*", baseUrlMatch: "https://zcode.z.ai/api/v1/zcode-plan" },
    ],
    builtinProviderModelRules: [{ providerId: "account:zai-individual-coding-plan", modelId: "m1" }],
  });
  template(upstream, "alpha", ["m1", "m2", "m3"]);
  template(upstream, "beta", ["b1"]);
  template(upstream, "gamma", ["g1"]);

  const result = buildSyncedConfigs({ upstream, currentProd, currentTest });

  assert.equal(result.prod.revision, 35);
  assert.equal(result.test.revision, 35);
  assert.deepEqual(result.templates.kept.sort(), ["alpha", "beta"]);
  assert.deepEqual(result.templates.notInAllowlist, ["gamma"]);
  // beta 在上游还在；alpha 的 m1/m2 保留 NIBI 的 enabled:true，m3 采用上游。
  const rules = result.prod.config.modelConfigRules.templateModelRules;
  const alpha = rules.filter((rule) => rule.templateId === "alpha");
  assert.deepEqual(
    alpha.map((rule) => [rule.modelId, rule.config.enabled]),
    [
      ["m1", true],
      ["m2", true],
      ["m3", true],
    ],
  );
  // 已下线的模型不留死规则。
  assert.equal(rules.some((rule) => rule.modelId === "gone"), false);
  // 站点规则与套餐规则不从上游导入。
  assert.deepEqual(result.prod.config.modelConfigRules.providerSiteRules, [
    { modelMatch: ".*", baseUrlMatch: "https://third.example" },
  ]);
  assert.deepEqual(result.prod.config.modelConfigRules.builtinProviderModelRules, []);
  // 测试专用站点规则只在 test 里保留。
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
  const currentProd = release({ revision: 3, templates: ["alpha", "retired"] });
  const currentTest = release({ revision: 3, templates: ["alpha", "retired"] });
  const upstream = release({ revision: 9, templates: ["alpha"] });
  const result = buildSyncedConfigs({ upstream, currentProd, currentTest });
  assert.deepEqual(result.templates.kept, ["alpha"]);
  assert.deepEqual(result.templates.missingUpstream, ["retired"]);
});

test("--add-template opts a new upstream template in and rejects unknown ids", () => {
  const currentProd = release({ revision: 3, templates: ["alpha"] });
  const currentTest = release({ revision: 3, templates: ["alpha"] });
  const upstream = release({ revision: 9, templates: ["alpha", "gamma"] });
  const added = buildSyncedConfigs({
    upstream,
    currentProd,
    currentTest,
    allow: ["gamma"],
  });
  assert.deepEqual(added.templates.kept.sort(), ["alpha", "gamma"]);
  assert.throws(
    () => buildSyncedConfigs({ upstream, currentProd, currentTest, allow: ["nope"] }),
    /not present upstream/u,
  );
});

test("rejects an invalid revision", () => {
  const currentProd = release({ revision: 3, templates: ["alpha"] });
  const currentTest = release({ revision: 3, templates: ["alpha"] });
  const upstream = release({ revision: 9, templates: ["alpha"] });
  assert.throws(
    () => buildSyncedConfigs({ upstream, currentProd, currentTest, revision: 0 }),
    /invalid revision/u,
  );
});
