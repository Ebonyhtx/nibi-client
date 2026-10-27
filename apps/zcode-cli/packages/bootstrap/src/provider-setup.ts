import { readFile } from "node:fs/promises";

import {
  ApiKeyAccessConfig,
  EnumOptionSpecConfig,
  LimitOptionSpecConfig,
  ModelInputFormatConfig,
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  parseProviderConfig,
} from "@nibi/provider";
import { resolveNodeProviderRuntimePaths } from "@nibi/provider-node";

import { startProcessProviderRegistryRuntime } from "./app/process-provider-registry-runtime.js";

/**
 * TUI 侧的 Provider 配置：列出内置模板、按模板创建一个 personal provider 并写入 API Key。
 *
 * 与 `auth-login.ts` 的分工：那里是智谱账号登录（OAuth / Coding Plan 凭据），
 * 这里是**与厂商无关**的 API Key 配置 —— 任何内置模板（DeepSeek、Anthropic、
 * OpenAI、Moonshot、OpenRouter…）都走同一条路，不需要账号体系。
 */

export interface ZCodeProviderTemplateSummary {
  readonly templateId: string;
  readonly name: string;
  readonly baseUrl?: string;
  readonly modelIds: readonly string[];
  readonly apiKeyManagementUrl?: string;
  /** 该模板是否使用厂商开放平台的普通 API Key（false = 账号类凭据，需登录）。 */
  readonly usesApiKey: boolean;
}

/** 自定义 Provider 支持的线协议；与内置模板用的是同一套枚举。 */
export type ZCodeCustomProviderApiType =
  | "anthropic-messages"
  | "openai-chat-completions"
  | "openai-responses";

export interface ZCodeCustomProviderSetupOptions {
  env?: Env;
  apiKey: string;
  apiType: ZCodeCustomProviderApiType;
  baseUrl: string;
  /**
   * 上下文窗口。**必须显式给**：内置 `.*` 兜底规则会给未知模型一个 200k 的猜测值，
   * 它会直接决定自动压缩阈值（`packages/core/src/compact/policy.ts`），
   * 填小了会过早压缩、填大了会撞上真实上限。
   */
  contextWindow: number;
  /** 单次最大输出。兜底值是 32k，且它是请求参数的硬上限，大输出模型必须覆盖。 */
  maxOutputTokens: number;
  /**
   * 输入模态。留空表示只用内置兜底（全部按不支持处理），会静默把图片/PDF 降级成文本。
   */
  modalities?: readonly ("image" | "pdf" | "video")[];
  modelId: string;
  /** 推理档位，**按强度从低到高**排列；顺序即语义。留空沿用兜底的 disabled/enabled 两档。 */
  reasoningLevels?: readonly string[];
  providerName?: string;
}

export interface ZCodeProviderSetupResult {
  readonly providerId: string;
  readonly templateName: string;
  readonly modelId?: string;
  readonly configPath?: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/** 模板名与 locale 只支持内置配置里存在的两种语言。 */
type ProviderLocale = "zh-CN" | "en-US";

function pickName(nameMap: unknown, locale: ProviderLocale | undefined): string {
  if (!nameMap || typeof nameMap !== "object") return "";
  const map = nameMap as Record<string, unknown>;
  const preferred = locale?.startsWith("zh") ? ["zh-CN", "en-US"] : ["en-US", "zh-CN"];
  for (const key of preferred) {
    const value = map[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const first = Object.values(map).find((v) => typeof v === "string" && v.trim());
  return typeof first === "string" ? first : "";
}

/**
 * 列出内置 Provider 模板。
 *
 * 直接读内置配置 JSON（路径由 CLI 启动时的 provider runtime env 解析）而不启动
 * registry runtime：面板要在用户敲下命令后立刻渲染，不能等一次 runtime 启动。
 * 只读展示用，因此不经过 provider 包的 codec。
 */
export async function listZCodeProviderTemplates(options: {
  env?: Env;
  locale?: ProviderLocale;
}): Promise<readonly ZCodeProviderTemplateSummary[]> {
  const env = options.env ?? process.env;
  const paths = resolveNodeProviderRuntimePaths(env);
  if (!paths) throw new Error("Provider 配置路径未初始化，无法列出模板。");

  const raw = await readFile(paths.nibiBuiltinFilePath, "utf-8");
  const parsed = JSON.parse(raw) as {
    config?: { providerConfigRules?: { templateRules?: unknown[] } };
  };
  const rules = parsed.config?.providerConfigRules?.templateRules;
  if (!Array.isArray(rules)) throw new Error("内置 Provider 配置缺少 templateRules。");

  return Object.freeze(
    rules.flatMap((rule): ZCodeProviderTemplateSummary[] => {
      const item = rule as {
        templateId?: unknown;
        templateNameMap?: unknown;
        config?: { access?: { type?: unknown; apiKeyManagementUrl?: unknown }; api?: { baseUrl?: unknown }; builtinModelIds?: unknown };
      };
      const templateId = typeof item.templateId === "string" ? item.templateId : "";
      if (!templateId) return [];
      const accessType = typeof item.config?.access?.type === "string" ? item.config.access.type : "";
      const modelIds = Array.isArray(item.config?.builtinModelIds)
        ? item.config.builtinModelIds.filter((id): id is string => typeof id === "string")
        : [];
      return [
        Object.freeze({
          templateId,
          name: pickName(item.templateNameMap, options.locale) || templateId,
          ...(typeof item.config?.api?.baseUrl === "string"
            ? { baseUrl: item.config.api.baseUrl }
            : {}),
          modelIds: Object.freeze(modelIds),
          ...(typeof item.config?.access?.apiKeyManagementUrl === "string"
            ? { apiKeyManagementUrl: item.config.access.apiKeyManagementUrl }
            : {}),
          usesApiKey: accessType === "api-key" || accessType === "zhipu-coding-plan-api-key",
        }),
      ];
    }),
  );
}

/**
 * 按模板创建 personal provider 并写入 API Key，同时把该模板的首个模型设为默认。
 *
 * 默认模型必须在这里写：登录/配置完成后当前会话不会重新读取默认选择，不写的话
 * 用户配好之后第一次发消息仍会撞上 "Select a model before continuing"。
 */
export async function setupZCodeProvider(options: {
  env?: Env;
  templateId: string;
  apiKey: string;
  locale?: ProviderLocale;
}): Promise<ZCodeProviderSetupResult> {
  const env = options.env ?? process.env;
  const templateId = options.templateId.trim();
  const apiKey = options.apiKey.trim();
  if (!templateId) throw new Error("缺少 Provider 模板 id。");
  if (!apiKey) throw new Error("缺少 API Key。");

  const runtime = await startProcessProviderRegistryRuntime(env, {});
  try {
    const templates = await listZCodeProviderTemplates({ env, locale: options.locale });
    const template = templates.find((item) => item.templateId === templateId);
    if (!template) throw new Error(`Provider 模板不存在：${templateId}`);

    const { providerId } = await runtime.runtime.configService.createPersonalProvider({
      templateId,
      ...(options.locale ? { locale: options.locale } : {}),
    });
    await runtime.runtime.configService.savePersonalProviderOverlay(
      providerId,
      new ProviderConfig({ access: new ApiKeyAccessConfig({ apiKey }) }),
    );

    const modelId = template.modelIds[0];
    if (modelId) {
      await runtime.modelSelectionConfigRepository.saveConfiguredDefault({ providerId, modelId });
    }

    return Object.freeze({
      providerId,
      templateName: template.name,
      ...(modelId ? { modelId } : {}),
    });
  } finally {
    runtime.dispose();
  }
}

/**
 * 配置一个自定义 Provider：不依赖任何内置模板，自己给 API 地址、线协议和模型 id。
 *
 * 与模板路径的差别：模板自带 baseUrl 与模型清单，这里三者都要用户提供，因此模型
 * 必须通过 `addPersonalModel` 显式登记 —— 只写 personalModelIds 不会让 Registry
 * 认为该模型可执行。
 */
export async function setupZCodeCustomProvider(
  options: ZCodeCustomProviderSetupOptions,
): Promise<ZCodeProviderSetupResult> {
  const env = options.env ?? process.env;
  const baseUrl = options.baseUrl.trim();
  const apiKey = options.apiKey.trim();
  const modelId = options.modelId.trim();
  if (!baseUrl) throw new Error("缺少 API 地址。");
  if (!apiKey) throw new Error("缺少 API Key。");
  if (!modelId) throw new Error("缺少模型 ID。");
  if (!Number.isInteger(options.contextWindow) || options.contextWindow <= 0) {
    throw new Error("上下文窗口必须是正整数。");
  }
  if (!Number.isInteger(options.maxOutputTokens) || options.maxOutputTokens <= 0) {
    throw new Error("最大输出必须是正整数。");
  }
  if (options.maxOutputTokens > options.contextWindow) {
    throw new Error("最大输出不能大于上下文窗口。");
  }
  const KNOWN_MODALITIES = ["image", "pdf", "video"] as const;
  const modalities = options.modalities ?? [];
  const unknown = modalities.filter(
    (m) => !(KNOWN_MODALITIES as readonly string[]).includes(m),
  );
  if (unknown.length) {
    throw new Error(`未知的输入模态：${unknown.join(", ")}（只支持 image / video / pdf）`);
  }
  const reasoningLevels = (options.reasoningLevels ?? []).map((v) => v.trim()).filter(Boolean);
  if (new Set(reasoningLevels).size !== reasoningLevels.length) {
    throw new Error("推理档位不能重复。");
  }

  const runtime = await startProcessProviderRegistryRuntime(env, {});
  try {
    const { providerId } = await runtime.runtime.configService.createPersonalProvider({
      providerName: options.providerName?.trim() || "Custom",
      initialConfig: new ProviderConfig({
        access: new ApiKeyAccessConfig({ apiKey }),
        api: new ProviderApiConfig({ baseUrl, type: options.apiType }),
      }),
    });
    // 只写这两个叶子：其余属性（输入模态、工具调用、能力位）与推理档位沿用内置
    // `.*` 兜底 + 按 apiType 匹配的推荐值，保持"智能模式"的稀疏覆盖语义。
    await runtime.runtime.configService.addPersonalModel(
      providerId,
      modelId,
      new ModelConfig({
        enabled: true,
        optionSpecs: new ModelOptionSpecsConfig({
          maxOutputTokens: new LimitOptionSpecConfig({ max: options.maxOutputTokens }),
          ...(reasoningLevels.length
            ? { reasoningLevel: new EnumOptionSpecConfig({ values: reasoningLevels }) }
            : {}),
        }),
        properties: new ModelPropertiesConfig({
          contextWindow: options.contextWindow,
          ...(modalities.length
            ? {
                inputFormat: new ModelInputFormatConfig({
                  supportsImage: modalities.includes("image"),
                  supportsPdf: modalities.includes("pdf"),
                  supportsText: true,
                  supportsVideo: modalities.includes("video"),
                }),
              }
            : {}),
        }),
      }),
    );
    await runtime.modelSelectionConfigRepository.saveConfiguredDefault({ providerId, modelId });

    return Object.freeze({
      providerId,
      templateName: options.providerName?.trim() || "Custom",
      modelId,
    });
  } finally {
    runtime.dispose();
  }
}

export interface ZCodeProviderRenameResult {
  readonly providerId: string;
  readonly providerName: string;
  readonly previousName?: string;
}

/**
 * 只改显示名。
 *
 * **providerId 不变**是硬约束：模型引用（`providerId/modelId`）、默认选型与历史会话都靠它定位，
 * 改名若动了 id，这些引用会全部失效。`nextPersonalProviderId` 里也钉了同一条不变式。
 *
 * 配置本体按当前值原样回写：保存入口会把传入的 config 整体写进 rule，传空配置会把该 provider
 * 的 apiKey / baseUrl 抹掉。membership 字段（builtinModelIds / personalModelIds）不走 config，
 * 由服务端按基线派生，所以先剥掉 —— 与桌面端 `persistPersonalProvider` 的做法一致。
 *
 * 重名由服务端的 `assertProviderLabelMutationIsUnique` 拒绝（抛 `Provider 名称已存在: X`）：
 * 改名是明确意图，静默加后缀反而会让人以为改成功了。
 */
export async function renameZCodeProvider(options: {
  env?: Env;
  providerId: string;
  providerName: string;
}): Promise<ZCodeProviderRenameResult> {
  const env = options.env ?? process.env;
  const providerId = options.providerId.trim();
  const providerName = options.providerName.trim();
  if (!providerId) throw new Error("缺少 providerId。");
  if (!providerName) throw new Error("缺少新的显示名。");

  const paths = resolveNodeProviderRuntimePaths(env);
  if (!paths) throw new Error("Provider 配置路径未初始化，无法改名。");
  const raw = JSON.parse(await readFile(paths.personalFilePath, "utf-8")) as {
    config?: {
      providerConfigRules?: {
        providerRules?: {
          providerId?: unknown;
          providerName?: unknown;
          config?: Record<string, unknown>;
        }[];
      };
    };
  };
  const rule = (raw.config?.providerConfigRules?.providerRules ?? []).find(
    (candidate) => candidate.providerId === providerId,
  );
  if (!rule) throw new Error(`Provider 不存在：${providerId}`);
  const previousName = typeof rule.providerName === "string" ? rule.providerName : undefined;
  const {
    builtinModelIds: _builtinModelIds,
    personalModelIds: _personalModelIds,
    ...providerConfig
  } = rule.config ?? {};

  const runtime = await startProcessProviderRegistryRuntime(env, {});
  try {
    await runtime.runtime.configService.savePersonalProviderOverlay(
      providerId,
      parseProviderConfig(providerConfig),
      undefined,
      { providerName },
    );
    return Object.freeze({
      providerId,
      providerName,
      ...(previousName === undefined ? {} : { previousName }),
    });
  } finally {
    runtime.dispose();
  }
}
