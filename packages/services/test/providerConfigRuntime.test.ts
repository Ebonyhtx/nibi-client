import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ModelConfigRules, ProviderConfigMap, ProviderTemplateMap } from "@nibi/provider";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";
import { setDataBaseDir } from "../src/paths.js";

function emptyBuiltinRelease(revision = 1) {
  return {
    schemaVersion: 1,
    revision,
    config: {
      providerConfigRules: { providerRules: [], templateRules: [] },
      modelConfigRules: {
        modelRules: [],
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  } as const;
}

describe("ProviderConfigRuntime", () => {
  it("保留含非法 endpoint 的 Personal Provider，并把问题留给 Registry 完整性校验", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-provider-runtime-"));
    const nibiBuiltinFilePath = join(root, "nibiBuiltin.json");
    const personalFilePath = join(root, "provider_config.json");
    await writeFile(nibiBuiltinFilePath, JSON.stringify(emptyBuiltinRelease()), "utf8");
    await writeFile(
      personalFilePath,
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "broken",
                config: {
                  group: "standard-personal",
                  access: { type: "api-key", apiKey: "broken-key" },
                  api: { type: "openai-chat-completions", baseUrl: "testtest" },
                  personalModelIds: ["broken-model"],
                },
              },
              {
                providerId: "valid",
                config: {
                  group: "standard-personal",
                  access: { type: "api-key", apiKey: "valid-key" },
                  api: { type: "openai-chat-completions", baseUrl: "https://api.example.com/v1" },
                  personalModelIds: ["valid-model"],
                },
              },
            ],
          },
          modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        },
      }),
      "utf8",
    );

    const recovery = vi.fn();
    const runtime = createProviderConfigRuntime({
      nibiBuiltinFilePath,
      personalFilePath,
      personalPollingIntervalMs: false,
      watch: false,
      onPersonalConfigRecovery: recovery,
    });

    try {
      await runtime.start();
      const snapshot = await runtime.configService.read();
      expect(snapshot.personalProviders.keys()).toEqual(["broken", "valid"]);
      expect(recovery).not.toHaveBeenCalled();
    } finally {
      runtime.dispose();
    }
  });



  it("本地候选 ready 后后台同步远端 Release，并把 Active 路径暴露给 Worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-provider-runtime-"));
    const bundledFilePath = join(root, "bundled.json");
    const activeFilePath = join(root, "cache", "active.json");
    await writeFile(bundledFilePath, JSON.stringify(emptyBuiltinRelease()), "utf8");
    const fetchRelease = vi.fn(async () => ({
      schemaVersion: 1 as const,
      revision: 2,
      config: {
        providerTemplates: ProviderTemplateMap.empty(),
        providers: ProviderConfigMap.empty(),
        modelConfigRules: ModelConfigRules.empty(),
      },
    }));
    const runtime = createProviderConfigRuntime({
      nibiBuiltinFilePath: bundledFilePath,
      nibiBuiltinActiveFilePath: activeFilePath,
      personalFilePath: join(root, "personal.json"),
      nibiBuiltinRemote: {
        controlFilePath: join(root, "cache", "refresh-control.json"),
        resolveEndpointKey: () => "https://example.com",
        fetchRelease,
      },
      watch: false,
    });

    await runtime.start();
    const initial = await runtime.configService.read();
    expect(initial.revision).toContain("nibi-builtin:1");
    await expect(runtime.resolveZCodeBuiltinActiveFilePath()).resolves.toBe(activeFilePath);
    await expect(runtime.refreshZCodeBuiltin({ force: true })).resolves.toBe("updated");
    expect((await runtime.configService.read()).revision).toContain("nibi-builtin:2");
    runtime.dispose();
  });
});
