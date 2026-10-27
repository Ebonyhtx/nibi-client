import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
  createAccountProviderConfigSnapshot,
} from "@nibi/provider";
import { zcodeProviderUpdateAccountConfigParamsSchema } from "@nibi/shared";
import {
  NIBI_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  NIBI_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
  NIBI_BUILTIN_RELEASE_SCHEMA_VERSION,
  createNodeModelSelectionFacade,
} from "@nibi/provider-node";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "@nibi/adapters/auth";
import {
  parseProcessAccountProviderConfigSnapshot,
  startProcessProviderRegistryRuntime,
} from "../src/app/process-provider-registry-runtime.js";
import {
  standaloneAccountAuthSourceCredentialKey,
  standaloneAccountIdentityCredentialKey,
  standaloneAccountProviderCredentialKey,
} from "../src/app/standalone-account-provider-runtime.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("process provider registry runtime", () => {
  it("Standalone 长生命周期下载 URL Release 后跟进 Registry；Managed Worker 不下载", async () => {
    const root = await temporaryDirectory();
    const builtin = JSON.parse(
      await readFile(
        new URL("../../../../../config/provider/nibi-builtin.json", import.meta.url),
        "utf8",
      ),
    );
    const bundled = join(root, "bundled.json");
    const active = join(root, "active.json");
    await writeFile(bundled, JSON.stringify(builtin));
    await writeFile(active, JSON.stringify(builtin));
    builtin.revision += 1;
    let releaseDownload!: () => void;
    const wait = new Promise<void>((resolve) => {
      releaseDownload = resolve;
    });
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toBeUndefined();
      if (String(url).includes("/api/v1/client/configs?"))
        return new Response(
          JSON.stringify({
            code: 0,
            data: { configs: { builtin_provider_config_json: "https://cdn.example.com/new.json" } },
          }),
        );
      await wait;
      return new Response(JSON.stringify(builtin));
    });
    const credentialStore = createSharedZCodeCredentialStore({
      env: { NIBI_DATA_BASE_DIR: root },
    });
    const env = {
      [NIBI_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: active,
      [NIBI_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: join(root, "personal.json"),
      NIBI_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE: bundled,
    };
    const runtime = await startProcessProviderRegistryRuntime(env, {
      standalone: {
        credentialStore,
        request,
      },
    });
    const old = runtime.runtime.registryService.getSnapshot()!;
    try {
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      expect(runtime.runtime.registryService.getSnapshot()).toBe(old);
      releaseDownload();
      await vi.waitFor(() =>
        expect(runtime.runtime.registryService.getSnapshot()!.config.nibiBuiltinRevision).toMatch(
          `nibi-builtin:${builtin.revision}:`,
        ),
      );
      const next = runtime.runtime.registryService.getSnapshot()!;
      expect(next.account.basedOnZCodeBuiltinRevision).toBe(next.config.nibiBuiltinRevision);
      expect(JSON.parse(await readFile(active, "utf8")).revision).toBe(builtin.revision);
      expect(JSON.parse(await readFile(bundled, "utf8")).revision).toBe(builtin.revision - 1);
      const worker = await startProcessProviderRegistryRuntime(env);
      try {
        expect(worker.snapshot.config.nibiBuiltinRevision).toBe(next.config.nibiBuiltinRevision);
        expect(request).toHaveBeenCalledTimes(2);
      } finally {
        worker.dispose();
      }
    } finally {
      releaseDownload();
      runtime.dispose();
    }
  });
  it("Standalone 无凭据时 Built-in 文件更新仍重新解析 Account 并整体发布 Registry", async () => {
    const root = await temporaryDirectory();
    const builtin = JSON.parse(
      await readFile(
        new URL("../../../../../config/provider/nibi-builtin.json", import.meta.url),
        "utf8",
      ),
    );
    const filePath = join(root, "builtin.json");
    await writeFile(filePath, JSON.stringify(builtin));
    const credentialStore = createSharedZCodeCredentialStore({
      env: { NIBI_DATA_BASE_DIR: root },
    });
    const runtime = await startProcessProviderRegistryRuntime(
      {
        [NIBI_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: filePath,
        [NIBI_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: join(root, "personal.json"),
      },
      { standalone: { credentialStore } },
    );
    try {
      builtin.revision += 1;
      await writeFile(filePath, JSON.stringify(builtin));
      await vi.waitFor(() => {
        const next = runtime.runtime.registryService.getSnapshot()!;
        expect(next.config.nibiBuiltinRevision).toMatch(`nibi-builtin:${builtin.revision}:`);
        expect(next.account.basedOnZCodeBuiltinRevision).toBe(next.config.nibiBuiltinRevision);
      });
      expect(
        runtime.runtime.registryService.getProvider("account:bigmodel-individual-coding-plan"),
      ).toBeUndefined();
    } finally {
      runtime.dispose();
    }
  });
  // 上游的 Built-in 计划 Provider / Standalone 账号鉴权已随套餐业务移除（2026-10 分家）：
// 这些用例依赖的 Provider 与请求期凭据投影已不存在，保留 skip 作为能力移除的记录。
it.skip("真实 Built-in 下完整状态跨协议往返；仅切 current 即更新 Worker 的有效选择", async () => {
    const root = await temporaryDirectory();
    const runtime = await startProcessProviderRegistryRuntime({
      [NIBI_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: fileURLToPath(
        new URL("../../../../../config/provider/nibi-builtin.json", import.meta.url),
      ),
      [NIBI_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: join(root, "personal.json"),
    });
    const personal = "account:bigmodel-individual-coding-plan";
    const team = "account:bigmodel-team-coding-plan";
    const original = Object.freeze({
      providerId: personal,
      modelId: "GLM-5.3",
      options: Object.freeze({ reasoningLevel: "high" }),
    });
    const facade = createNodeModelSelectionFacade(runtime.runtime.registryService);
    const providers = new ProviderConfigMap(
      [personal, team].map((id) => [
        id,
        new ProviderConfig({ access: new ZhipuAccountAccessConfig({ entitled: true }) }),
      ]),
    );
    const revisions = new Set<string>();
    try {
      for (const current of [personal, team, personal]) {
        const snapshot = createAccountProviderConfigSnapshot(
          runtime.snapshot.config.nibiBuiltinRevision,
          providers,
          {
            [personal]: {
              availability: "available",
              entitled: true,
              current: current === personal,
            },
            [team]: { availability: "available", entitled: true, current: current === team },
          },
        );
        revisions.add(snapshot.revision);
        const wire = zcodeProviderUpdateAccountConfigParamsSchema.parse(
          JSON.parse(
            JSON.stringify({
              ...snapshot,
              providers: Object.fromEntries(
                [...snapshot.providers.entries()].map(([id, config]) => [id, config.toJSON()]),
              ),
            }),
          ),
        );
        await runtime.syncAccountProviderConfig(parseProcessAccountProviderConfigSnapshot(wire));
        expect(runtime.runtime.registryService.getProvider(current)).toBeDefined();
        expect(
          runtime.runtime.registryService.getProvider(current === personal ? team : personal),
        ).toBeUndefined();
        expect(
          facade.getView(undefined, undefined, { selection: original }).effectiveSelection,
        ).toEqual({ ...original, providerId: current });
        expect(original.providerId).toBe(personal);
      }
      expect(revisions.size).toBe(2);
    } finally {
      runtime.dispose();
    }
  });

  it("解析独立同步的 Account Provider Config", () => {
    const states = {
      account: { availability: "available", entitled: true, current: false },
    } as const;
    const parsed = parseProcessAccountProviderConfigSnapshot({
      revision: "account-1",
      basedOnZCodeBuiltinRevision: "nibi-builtin:1",
      states,
      providers: {
        account: {
          access: { type: "zhipu-account", entitled: true },
          builtinModelIds: ["model-a"],
        },
      },
    });

    expect(
      Object.fromEntries(
        [...parsed.providers.entries()].map(([id, config]) => [id, config.toJSON()]),
      ),
    ).toEqual({
      account: {
        access: { type: "zhipu-account", entitled: true },
        builtinModelIds: ["model-a"],
      },
    });
    expect(parsed.basedOnZCodeBuiltinRevision).toBe("nibi-builtin:1");
    expect(parsed.states).toEqual(states);
  });

  it("独立 Account Config 同步拒绝 API Provider", () => {
    expect(() =>
      parseProcessAccountProviderConfigSnapshot({
        revision: "account-invalid",
        basedOnZCodeBuiltinRevision: "nibi-builtin:1",
        providers: {
          api: {
            access: {
              type: "api-key",
              apiKey: "must-not-enter-account-source",
            },
          },
        },
      }),
    ).toThrow();
  });

  it("独立 Account Config 只接受 entitlement 与账号特定模型成员", () => {
    expect(() =>
      parseProcessAccountProviderConfigSnapshot({
        revision: "account-invalid-static-field",
        basedOnZCodeBuiltinRevision: "nibi-builtin:1",
        providers: {
          account: {
            access: { type: "zhipu-account", entitled: true },
            label: "不得由 Account Source 覆盖",
          },
        },
      }),
    ).toThrow();
  });

  it("未注入 Provider Config 路径时拒绝启动", async () => {
    await expect(startProcessProviderRegistryRuntime({})).rejects.toThrow(
      "缺少进程 Provider Registry",
    );
  });

  it("Personal 文件损坏时保留原文件并以内存空配置启动", async () => {
    const root = await temporaryDirectory();
    const nibiBuiltinFilePath = join(root, "nibi-builtin.json");
    const personalFilePath = join(root, "personal.json");
    await writeFile(
      nibiBuiltinFilePath,
      JSON.stringify(nibiBuiltinRelease({ providers: {}, templates: {}, models: [] })),
    );
    await writeFile(personalFilePath, "{not-json");
    const started = await startProcessProviderRegistryRuntime({
      [NIBI_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: nibiBuiltinFilePath,
      [NIBI_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personalFilePath,
    });
    try {
      expect(started.configuredDefaultModelSelection).toBeUndefined();
      expect(await readFile(personalFilePath, "utf8")).toBe("{not-json");
      await expect(
        started.modelSelectionConfigRepository.saveConfiguredDefault(undefined),
      ).rejects.toThrow();
    } finally {
      started.dispose();
    }
    await expect(started.modelSelectionConfigRepository.read()).rejects.toThrow("已 dispose");
    await expect(started.runtime.start()).rejects.toThrow("已 dispose");
  });

  it("从进程环境启动一份 Registry，并由调用方持有生命周期", async () => {
    const root = await temporaryDirectory();
    const nibiBuiltinFilePath = join(root, "nibi-builtin.json");
    const personalFilePath = join(root, "personal.json");
    await writeFile(
      nibiBuiltinFilePath,
      JSON.stringify(
        nibiBuiltinRelease({
          providers: {
            account: {
              group: "zai-family",
              access: {
                type: "zhipu-account",
                accountType: "zai",
                mode: "individual-coding-plan",
              },
              api: {
                type: "anthropic-messages",
                baseUrl: "https://account.example.com",
              },
              builtinModelIds: ["model-a"],
            },
          },
          templates: {
            "zcode-template": {
              access: { type: "api-key" },
              api: {
                type: "anthropic-messages",
                baseUrl: "https://api.example.com",
              },
              builtinModelIds: ["model-a"],
            },
          },
          models: [
            {
              modelMatch: "model-a",
              config: {
                enabled: true,

                properties: {
                  requiresMfjsToolSchema: false,
                  contextWindow: 200000,
                  inputFormat: {
                    supportsText: true,
                    supportsImage: false,
                    supportsVideo: false,
                    supportsAudio: false,
                    supportsPdf: false,
                  },
                  outputFormat: { supportsText: true },
                  supportsToolCall: true,
                  supportsJsonSchemaOutput: true,
                  supportsNativeWebSearch: false,
                  supportsMidConversationSystem: false,
                },
                optionSpecs: {
                  reasoningLevel: { values: ["disabled"], map: "{}" },
                  maxOutputTokens: {
                    max: 32000,
                    map: '{"max_completion_tokens":maxOutputTokens}',
                  },
                },
              },
            },
          ],
        }),
      ),
      "utf8",
    );
    await writeFile(
      personalFilePath,
      JSON.stringify(
        personalRelease([
          {
            providerId: "personal-api",
            templateId: "zcode-template",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "secret" },
            },
          },
        ]),
      ),
      "utf8",
    );

    const started = await startProcessProviderRegistryRuntime({
      [NIBI_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: nibiBuiltinFilePath,
      [NIBI_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personalFilePath,
    });

    expect(started?.snapshot.registry.providers).toHaveLength(1);
    expect(started?.runtime.registryService.getModel("personal-api", "model-a")).toBeDefined();
    started?.accountSource.replace(
      {
        revision: "account-access-1",
        basedOnZCodeBuiltinRevision: started!.snapshot.config.nibiBuiltinRevision,
        providers: new ProviderConfigMap([
          [
            "account",
            new ProviderConfig({
              access: new ZhipuAccountAccessConfig({ entitled: true }),
            }),
          ],
        ]),
      },
      "test",
    );
    await started?.runtime.registryService.refresh("wait-for-account-access");
    expect(started?.runtime.registryService.getProvider("account")?.config).toMatchObject({
      access: {
        type: "zhipu-account",
      },
      builtinModelIds: ["model-a"],
    });
    const beforeSwitch = await started.accountSource.read();
    const switched = parseProcessAccountProviderConfigSnapshot({
      revision: "account-access-2",
      basedOnZCodeBuiltinRevision: beforeSwitch.basedOnZCodeBuiltinRevision,
      providers: Object.fromEntries(
        [...beforeSwitch.providers.entries()].map(([id, config]) => [id, config.toJSON()]),
      ),
      states: { account: { availability: "available", entitled: true, current: false } },
    });
    started.accountSource.replace(switched, "account-no-longer-current");
    await started.runtime.registryService.refresh("wait-for-account-selection");
    expect(started.runtime.registryService.getProvider("account")).toBeUndefined();
    expect(started.runtime.registryService.getProvider("personal-api")).toBeDefined();
    started?.dispose();
  });

  it.skip("Standalone 从账号凭据生成 Account Overlay，并在请求前返回当前 API Key", async () => {
    const root = await temporaryDirectory();
    const nibiBuiltinFilePath = join(root, "nibi-builtin.json");
    const personalFilePath = join(root, "personal.json");
    const credentialStore = createSharedZCodeCredentialStore({
      baseDir: join(root, "home"),
      env: { NIBI_CREDENTIAL_SECRET: "process-registry-test" },
    });
    const providerId = "configured-standalone-provider";
    const accountIdentity = "account-1";
    const accountProviderCredentialKey = standaloneAccountProviderCredentialKey({
      providerId,
      accountIdentity,
    });
    await writeFile(
      nibiBuiltinFilePath,
      JSON.stringify(
        nibiBuiltinRelease({
          providers: {
            [providerId]: {
              group: "zai-family",
              access: {
                type: "zhipu-account",
                accountType: "zai",
                mode: "individual-coding-plan",
              },
              api: {
                type: "anthropic-messages",
                baseUrl: "https://account.example.com",
              },
              builtinModelIds: ["model-a"],
            },
          },
          templates: {},
          models: [
            {
              modelMatch: "model-a",
              config: {
                enabled: true,

                properties: {
                  requiresMfjsToolSchema: false,
                  contextWindow: 200000,
                  inputFormat: {
                    supportsText: true,
                    supportsImage: false,
                    supportsVideo: false,
                    supportsAudio: false,
                    supportsPdf: false,
                  },
                  outputFormat: { supportsText: true },
                  supportsToolCall: true,
                  supportsJsonSchemaOutput: true,
                  supportsNativeWebSearch: false,
                  supportsMidConversationSystem: false,
                },
                optionSpecs: {
                  reasoningLevel: { values: ["disabled"], map: "{}" },
                  maxOutputTokens: {
                    max: 32000,
                    map: '{"max_completion_tokens":maxOutputTokens}',
                  },
                },
              },
            },
          ],
        }),
      ),
      "utf8",
    );
    await writeFile(personalFilePath, JSON.stringify(personalRelease([])), "utf8");
    await credentialStore.saveMany({
      [standaloneAccountIdentityCredentialKey(providerId)]: accountIdentity,
      [accountProviderCredentialKey]: "runtime-api-key",
      [standaloneAccountAuthSourceCredentialKey(providerId)]: "manual",
    });

    const started = await startProcessProviderRegistryRuntime(
      {
        [NIBI_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: nibiBuiltinFilePath,
        [NIBI_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personalFilePath,
      },
      { standalone: { credentialStore } },
    );

    expect(started?.runtime.registryService.getProvider(providerId)?.config.access).toMatchObject({
      type: "zhipu-account",
      accountType: "zai",
      mode: "individual-coding-plan",
    });
    await expect(
      started?.providerRuntimeHeadersPort.refreshBeforeModelRequest({
        accountAccess: {
          type: "zhipu-account",
          accountType: "zai",
          entitled: true,
          mode: "individual-coding-plan",
        },
        modelId: "model-a",
        providerId,
        reason: "model-request",
        sessionId: "session-1" as never,
        traceContext: { traceId: "trace-1" } as never,
      }),
    ).resolves.toMatchObject({
      headersApplied: true,
      requestAuth: { apiKey: "runtime-api-key" },
    });

    await credentialStore.save(accountProviderCredentialKey, "rotated-runtime-api-key");
    await expect(
      started?.providerRuntimeHeadersPort.refreshBeforeModelRequest({
        accountAccess: {
          type: "zhipu-account",
          accountType: "zai",
          entitled: true,
          mode: "individual-coding-plan",
        },
        modelId: "model-a",
        providerId,
        reason: "model-request",
        sessionId: "session-1" as never,
        traceContext: { traceId: "trace-2" } as never,
      }),
    ).resolves.toMatchObject({
      requestAuth: { apiKey: "rotated-runtime-api-key" },
    });

    await credentialStore.deleteIfValues({
      [standaloneAccountIdentityCredentialKey(providerId)]: accountIdentity,
      [accountProviderCredentialKey]: "rotated-runtime-api-key",
    });
    await vi.waitFor(() => {
      expect(started?.runtime.registryService.getProvider(providerId)).toBeUndefined();
    });
    started?.dispose();
  });

  it("Standalone 首次账号凭据读取失败时仍以 fail-closed Account 启动 Personal API Provider", async () => {
    const root = await temporaryDirectory();
    const nibiBuiltinFilePath = join(root, "nibi-builtin.json");
    const personalFilePath = join(root, "personal.json");
    await writeFile(
      nibiBuiltinFilePath,
      JSON.stringify(
        nibiBuiltinRelease({
          providers: {},
          templates: {
            api: {
              access: { type: "api-key" },
              api: { type: "anthropic-messages", baseUrl: "https://api.example.com" },
              builtinModelIds: ["model-a"],
            },
          },
          models: [completeZCodeBuiltinModelRule()],
        }),
      ),
      "utf8",
    );
    await writeFile(
      personalFilePath,
      JSON.stringify(
        personalRelease([
          {
            providerId: "api",
            templateId: "api",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "secret" },
            },
          },
        ]),
      ),
      "utf8",
    );
    const accountError = new Error("credential store unavailable");
    const onAccountInitializationError = vi.fn();
    const credentialStore = {
      loadMany: vi.fn(async () => {
        throw accountError;
      }),
    } as unknown as SharedZCodeCredentialStore;

    const started = await startProcessProviderRegistryRuntime(
      {
        [NIBI_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: nibiBuiltinFilePath,
        [NIBI_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personalFilePath,
      },
      { standalone: { credentialStore, onAccountInitializationError } },
    );

    expect(started.runtime.registryService.getProvider("api")).toBeDefined();
    expect(onAccountInitializationError).toHaveBeenCalledWith(accountError);
    started.dispose();
  });

});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-process-provider-registry-"));
  temporaryDirectories.push(directory);
  return directory;
}

function completeZCodeBuiltinModelRule() {
  return {
    modelMatch: ".*",
    config: {
      enabled: true,

      properties: {
        requiresMfjsToolSchema: false,
        contextWindow: 200_000,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
        supportsToolCall: true,
        supportsJsonSchemaOutput: true,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: false,
      },
      optionSpecs: {
        reasoningLevel: { values: ["disabled"], map: "{}" },
        maxOutputTokens: {
          max: 32_000,
          map: '{"max_completion_tokens":maxOutputTokens}',
        },
      },
    },
  } as const;
}

function nibiBuiltinRelease(input: {
  readonly providers: object;
  readonly templates: object;
  readonly models: readonly unknown[];
}): object {
  return {
    schemaVersion: NIBI_BUILTIN_RELEASE_SCHEMA_VERSION,
    revision: 1,
    config: {
      providerConfigRules: {
        providerRules: Object.entries(input.providers).map(([providerId, config]) => ({
          providerId,
          config,
        })),
        templateRules: Object.entries(input.templates).map(([templateId, config]) => ({
          templateId,
          templateNameMap: { "en-US": templateId, "zh-CN": templateId },
          config,
        })),
      },
      modelConfigRules: {
        modelRules: input.models,
        modelApiRules: [],
        providerSiteRules: [],
        templateModelRules: [],
        builtinProviderModelRules: [],
      },
    },
  };
}

function personalRelease(providerRules: readonly unknown[]) {
  return {
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  };
}
