import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createModel as createExecutableModel,
  type AiSdkModelAdapter,
  type CreateAiSdkModelOptions,
} from "@nibi/adapters/model";
import { type ModelEvent, type ModelRequest, type ModelResult } from "@nibi/contracts";
import {
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderRegistry,
  type Provider,
} from "@nibi/provider";
import { createNibiApp } from "../../src/app/create-app.js";
import type { NibiApp, NibiAppOptions } from "../../src/app/types.js";
import { createApiKeyProviderConfig } from "../provider-config-fixtures.js";

const DEFAULT_TEST_MODEL = {
  providerId: "zai",
  modelId: "glm-4.6",
} as const;

/**
 * 测试基座默认不隔离官方内置插件。`design` 默认启用且注册了 SessionStart hook，
 * 它的命令、hook_run_* 事件与注入消息会混进 workspace Hook / 持久化断言。
 *
 * 插件解析读取的是 configResult.plugins（runtimeConfig.plugins 不参与），因此隔离手段
 * 只能是在 user/project 配置文件里写 suppressedBuiltins，再把该配置传给 createNibiApp。
 * 这里只影响测试，不改变产品默认值。
 */
export const TEST_SUPPRESSED_BUILTIN_PLUGINS = ["design@nibi-official"] as const;

/** 写 user/project config 时合并这份片段即可抑制测试中的 design 插件。 */
export function testSuppressedBuiltinPluginsConfig(): {
  plugins: { suppressedBuiltins: string[] };
} {
  return { plugins: { suppressedBuiltins: [...TEST_SUPPRESSED_BUILTIN_PLUGINS] } };
}

/**
 * 在指定目录写入一份只声明插件抑制的项目配置（`.nibi/config.json`）。
 * 适用于 workingDirectory 是临时目录、且测试没有现成配置文件的场景。
 */
export async function writeSuppressedBuiltinPluginsProjectConfig(
  directory: string,
): Promise<void> {
  const configDir = join(directory, ".nibi");
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify(testSuppressedBuiltinPluginsConfig()),
  );
}

export interface RegistryBackedTestModelExecution {
  providerId: string;
  modelId: string;
}

export interface RegistryBackedTestModelExecutor {
  generateText(
    request: ModelRequest,
    execution: RegistryBackedTestModelExecution,
  ): Promise<ModelResult>;
  streamText?(
    request: ModelRequest,
    execution: RegistryBackedTestModelExecution,
  ): AsyncIterable<ModelEvent>;
}

type RegistryBackedTestAppOptions = Omit<NibiAppOptions, "providerRegistry"> & {
  modelExecutor?: RegistryBackedTestModelExecutor;
  providerRegistry?: NibiAppOptions["providerRegistry"];
};

// 测试创建过的 app 必须显式 close：MCP/插件子进程以工作区为 cwd，Windows 上
// 只要还有一个活着，rm(tempRoot) 就是 EBUSY（Linux 上删得掉，于是问题只在 Windows 暴露）。
// 这里统一登记，由 closeTrackedTestApps() 在删除临时目录前收尾。
const trackedTestApps = new Set<NibiApp>();

export async function closeTrackedTestApps(): Promise<void> {
  const apps = [...trackedTestApps];
  trackedTestApps.clear();
  for (const app of apps) {
    try {
      await app.close?.();
    } catch {
      // 收尾失败不应把用例本身判红：真正的断言已经在用例里跑完了。
    }
  }
}

export async function createRegistryBackedTestApp(
  options: RegistryBackedTestAppOptions = {},
): Promise<NibiApp> {
  const modelSelections = collectModelSelections(options);
  const providerRegistry = options.providerRegistry ?? createTestProviderRegistry(modelSelections);
  const { modelExecutor, ...appOptions } = options;

  const app = await createNibiApp({
    ...appOptions,
    runtimeConfig: {
      ...appOptions.runtimeConfig,
      // 测试基座默认关闭标题生成，避免无关 Session 测试产生额外模型调用与事件。
      titleGeneration: appOptions.runtimeConfig?.titleGeneration ?? { enabled: false },
    },
    providerRegistry,
    ...(modelExecutor ? { modelAdapter: createRegistryBackedTestModelAdapter(modelExecutor) } : {}),
  });
  trackedTestApps.add(app);
  return app;
}

export function createTestProviderRegistry(
  modelSelections: readonly { providerId: string; modelId: string }[] = [DEFAULT_TEST_MODEL],
): ProviderRegistry {
  const orderedSelections = dedupeModelSelections([DEFAULT_TEST_MODEL, ...modelSelections]);
  const modelsByProvider = new Map<string, string[]>();
  for (const selection of orderedSelections) {
    const providerId = String(selection.providerId);
    const modelId = String(selection.modelId);
    const models = modelsByProvider.get(providerId) ?? [];
    models.push(modelId);
    modelsByProvider.set(providerId, models);
  }

  const providers: Provider[] = Array.from(modelsByProvider, ([providerId, modelIds]) => ({
    providerId,
    config: createApiKeyProviderConfig({
      apiFormat: "anthropic-messages",
      apiKey: "registry-test-key",
      baseURL: `https://${providerId}.registry.test`,
      models: modelIds,
    }),
    models: modelIds.map((modelId) => ({
      modelId,
      config: createTestModelConfig(),
    })),
  }));
  return new ProviderRegistry(providers);
}

function createTestModelConfig(): ModelConfig {
  const reasoningLevels = ["low", "medium", "high", "deep"] as const;
  return new ModelConfig({
    enabled: true,
    visibility: "visible",

    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: 1_000_000,
      inputFormat: {
        supportsText: true,
        supportsImage: true,
        supportsVideo: true,
        supportsAudio: false,
        supportsPdf: true,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: {
        values: reasoningLevels,
        map: '{"output_config":{"effort":reasoningLevel}}',
      },
      maxOutputTokens: {
        max: 1_000_000,
        map: '{"max_tokens":maxOutputTokens}',
      },
    }),
  });
}

function collectModelSelections(
  options: RegistryBackedTestAppOptions,
): { providerId: string; modelId: string }[] {
  const selections: { providerId: string; modelId: string }[] = [];
  const add = (selection: { providerId: string; modelId: string } | undefined) => {
    if (selection) selections.push(selection);
  };
  if (options.runtimeConfig?.modelSelection) {
    selections.push(options.runtimeConfig.modelSelection);
  }
  add(options.runtimeConfig?.titleGeneration?.modelSelection);
  if (options.configuredDefaultModelSelection) {
    selections.push(options.configuredDefaultModelSelection);
  }
  return selections;
}

function dedupeModelSelections(
  selections: readonly { providerId: string; modelId: string }[],
): { providerId: string; modelId: string }[] {
  const seen = new Set<string>();
  return selections.filter((selection) => {
    const key = `${String(selection.providerId)}/${String(selection.modelId)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createRegistryBackedTestModelAdapter(
  executor: RegistryBackedTestModelExecutor,
): AiSdkModelAdapter {
  return {
    addStatusSink: () => {},
    createModel: (input: CreateAiSdkModelOptions) => {
      const execution = (request: ModelRequest): RegistryBackedTestModelExecution => ({
        providerId: input.providerId,
        modelId: input.modelId,
      });
      return createExecutableModel({
        providerId: input.providerId,
        modelId: input.modelId,
        displayName: input.displayName,
        properties: input.modelConfig.properties,
        optionSpecs: input.modelConfig.optionSpecs,
        options: input.options,
        executor: {
          generateText: (request) => executor.generateText(request, execution(request)),
          streamText: (request) =>
            executor.streamText?.(request, execution(request)) ??
            streamResult(executor.generateText(request, execution(request))),
        },
      });
    },
    setModelIoFullRetentionEnabled: () => {},
  } as unknown as AiSdkModelAdapter;
}

async function* streamResult(result: Promise<ModelResult>): AsyncIterable<ModelEvent> {
  const resolved = await result;
  if (resolved.text) {
    yield { id: "bootstrap-test-text", type: "text_start" };
    yield { id: "bootstrap-test-text", text: resolved.text, type: "text_delta" };
    yield { id: "bootstrap-test-text", type: "text_end" };
  }
  yield {
    finishReason: resolved.finishReason,
    type: "finish",
    usage: resolved.usage,
  };
}
