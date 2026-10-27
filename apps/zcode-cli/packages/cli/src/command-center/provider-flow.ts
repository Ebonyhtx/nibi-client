import type { TuiSelection } from "@nibi/tui";
import { getZCodeCopy } from "@nibi/i18n";

import type {
  CommandCenterProviderSetupResult,
  CommandCenterProviderTemplate,
} from "./types.js";

/**
 * `/provider` 的选择面板与自定义 Provider 的分步输入。
 *
 * 两条路径：
 * - 模板路径：内置模板自带 API 地址与模型清单，只需一个 API Key。
 * - 自定义路径：API 地址、模型 ID、API Key 三者都要用户给，因此分三步。
 *
 * **API Key 始终是命令的最后一个参数**：转写区按"末位即密钥"脱敏（见
 * `app-submit.ts` 的 redactSubmittedText），自定义流程的参数顺序因此固定为
 * `baseUrl → modelId → apiKey`，不能把 Key 放到中间。
 */

export const CUSTOM_PROVIDER_IDS = ["custom-openai", "custom-anthropic"] as const;

export type CustomProviderId = (typeof CUSTOM_PROVIDER_IDS)[number];

export function isCustomProviderId(value: string): value is CustomProviderId {
  return (CUSTOM_PROVIDER_IDS as readonly string[]).includes(value);
}

/** 输入模态的合法取值；`-` 表示不声明（沿用兜底，全部按不支持处理）。 */
export const CUSTOM_MODALITY_TOKENS = ["image", "video", "pdf"] as const;

/** `-` / `none` 表示"不声明、用默认"。输入框不允许空提交，所以需要这个哨兵值。 */
export function isSkipToken(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v === "-" || v === "none";
}

export type CustomProviderValues = {
  apiKey?: string;
  baseUrl?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  modalities?: readonly string[];
  modelId?: string;
  reasoningLevels?: readonly string[];
};

export type CustomProviderStep = { step: number } & CustomProviderValues;

function parseLimits(a: string | undefined, b: string | undefined) {
  const contextWindow = Number(a);
  const maxOutputTokens = Number(b);
  const valid =
    Number.isInteger(contextWindow) &&
    contextWindow > 0 &&
    Number.isInteger(maxOutputTokens) &&
    maxOutputTokens > 0;
  return valid ? { contextWindow, maxOutputTokens } : undefined;
}

function parseList(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (isSkipToken(value)) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 自定义 Provider 的默认显示名：从 API 地址的主机名推（`https://api.deepseek.com/v1` →
 * `deepseek`，`https://tokenrhythm.studio/v1` → `tokenrhythm`）。
 *
 * 去掉 `api.` / `openapi.` / `www.` / `gateway.` 这类网关前缀，再取顶层域名之前的第一段：
 * 结果同时是 provider id 的种子（见 provider 包 nextPersonalProviderId），所以越短越可读。
 * 推不出来就退回主机名，再不行退回 "Custom"。
 */
export function defaultCustomProviderName(baseUrl: string | undefined): string {
  const host = hostnameOf(baseUrl);
  if (!host) return "Custom";
  const withoutGatewayPrefix = host.replace(/^(?:api|openapi|www|gateway|llm)\./iu, "");
  const firstLabel = withoutGatewayPrefix.split(".")[0]?.trim();
  return firstLabel || host;
}

function hostnameOf(baseUrl: string | undefined): string | undefined {
  const trimmed = baseUrl?.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed).hostname.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** `/provider rename <providerId> <新名字>`；名字允许带空格。 */
export function parseProviderRenameArgs(
  args: string,
): { providerId: string; providerName: string } | null {
  const parts = args.trim().split(/\s+/u);
  if (parts[0] !== "rename") return null;
  const providerId = parts[1]?.trim();
  const providerName = parts.slice(2).join(" ").trim();
  if (!providerId || !providerName) return null;
  return { providerId, providerName };
}

/**
 * 按已给的参数判断自定义流程走到第几步（共 7 个输入步）。
 *
 * 参数顺序固定为
 * `baseUrl → modelId → contextWindow → maxOutputTokens → modalities → reasoningLevels → apiKey`，
 * 密钥必须留在末位（转写区脱敏依赖这一点），token 限额那一步一次输入两个数字，
 * 因此会占掉两个参数位。
 *
 * 显示名不在这里问：它由 `defaultCustomProviderName(baseUrl)` 自动推导，想改走
 * `/provider rename`（只改显示名，provider id 不变）。
 */
export function customProviderStep(values: readonly string[]): CustomProviderStep {
  const [baseUrl, modelId, cw, mo, modalities, reasoning, apiKey] = values;
  const limits = parseLimits(cw, mo);
  const base = { baseUrl, modelId, ...(limits ?? {}) };
  if (!baseUrl) return { step: 0 };
  if (!modelId) return { step: 1, baseUrl };
  if (!limits) return { step: 2, baseUrl, modelId };
  if (modalities === undefined) return { ...base, step: 3 };
  const modalityList = parseList(modalities) ?? [];
  if (reasoning === undefined) return { ...base, modalities: modalityList, step: 4 };
  const reasoningLevels = parseList(reasoning) ?? [];
  if (apiKey === undefined) return { ...base, modalities: modalityList, reasoningLevels, step: 5 };
  return { ...base, apiKey, modalities: modalityList, reasoningLevels, step: 6 };
}

export function buildProviderSelection(
  locale: string | undefined,
  templates: readonly CommandCenterProviderTemplate[],
): TuiSelection {
  const copy = getZCodeCopy(locale).tui.providerSetup;
  return {
    emptyMessage: copy.emptyMessage,
    filterable: true,
    help: copy.help,
    items: [
      ...CUSTOM_PROVIDER_IDS.map((id) => ({
        command: `/provider ${id}`,
        id,
        keywords: [id, "custom"],
        primary: id === "custom-openai" ? copy.custom.openai : copy.custom.anthropic,
        secondary: copy.custom.hint,
      })),
      ...templates.map((template) => ({
        command: `/provider ${template.templateId}`,
        id: template.templateId,
        keywords: [template.templateId, template.name],
        input: {
          cancelStatus: copy.input.cancelStatus,
          clearStatus: copy.input.clearStatus,
          emptyStatus: copy.input.emptyStatus,
          help: copy.input.help,
          mask: true,
          placeholder: copy.input.placeholder,
          primary: copy.input.primary,
          secondary: copy.input.secondary,
          status: copy.input.status,
          submitStatus: copy.input.submitStatus,
        },
        primary: template.name,
        secondary: template.hint ?? copy.itemHint,
      })),
    ],
    prompt: copy.prompt,
    title: copy.title,
  };
}

export function providerSetupResponse(locale?: string): string {
  return getZCodeCopy(locale).tui.providerSetup.response;
}

/** `/provider <templateId> <apiKey>`：模板路径，面板提交后走这条。 */
export function parseProviderArgs(
  args: string,
): { apiKey: string; templateId: string } | null {
  const parts = args.trim().split(/\s+/u);
  const templateId = parts[0]?.trim();
  if (!templateId || parts.length < 2) return null;
  return { apiKey: parts.slice(1).join(" ").trim(), templateId };
}

/** 推理档位的候选，**按强度从弱到强**；提交时按这个顺序重排，顺序即语义。 */
export const REASONING_LEVEL_OPTIONS = [
  "disabled",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

/** 多选面板的通用形状：勾选后提交 id 的逗号拼接。 */
function multiSelectStep(input: {
  baseCommand: string;
  emptyMessage: string;
  help: string;
  options: readonly string[];
  prompt: string;
  selected: readonly string[];
  submitStatus: string;
  title: string;
}): TuiSelection {
  return {
    emptyMessage: input.emptyMessage,
    filterable: false,
    help: input.help,
    items: input.options.map((option) => ({
      command: "",
      id: option,
      primary: option,
    })),
    multiSelect: { command: input.baseCommand, submitStatus: input.submitStatus },
    prompt: input.prompt,
    title: input.title,
  };
}

/**
 * 自定义流程当前步骤的提示语与面板。
 *
 * 第 1-3 步（地址、模型 ID、token 限额）与最后一步（API Key）是自由输入；
 * 第 4-5 步（输入模态、推理档位）取值集合固定，改为**空格勾选的多选面板**，
 * 用户不必记忆拼写，也不会写出非法值。
 */
export function buildCustomProviderStep(
  locale: string | undefined,
  providerId: CustomProviderId,
  state: CustomProviderStep,
): { response: string; selection: TuiSelection } {
  const copy = getZCodeCopy(locale).tui.providerSetup.custom;
  const prefix = `/provider ${providerId}`;
  const limits =
    state.contextWindow !== undefined && state.maxOutputTokens !== undefined
      ? [String(state.contextWindow), String(state.maxOutputTokens)]
      : [];
  const carriedForModalities = [state.baseUrl!, state.modelId!, ...limits];
  const modalities = state.modalities ?? [];

  if (state.step === 3) {
    return {
      response: `${copy.stepModalities.title}
${copy.stepModalities.help}`,
      selection: multiSelectStep({
        baseCommand: [prefix, ...carriedForModalities].join(" "),
        emptyMessage: copy.emptyMessage,
        help: copy.multiSelectHelp,
        options: CUSTOM_MODALITY_TOKENS,
        prompt: copy.stepModalities.title,
        selected: modalities,
        submitStatus: copy.multiSelectSubmit,
        title: copy.stepModalities.title,
      }),
    };
  }
  if (state.step === 4) {
    const carried = [...carriedForModalities, modalities.join(",") || "-"];
    return {
      response: `${copy.stepReasoning.title}
${copy.stepReasoning.help}`,
      selection: multiSelectStep({
        baseCommand: [prefix, ...carried].join(" "),
        emptyMessage: copy.emptyMessage,
        help: copy.multiSelectHelp,
        options: REASONING_LEVEL_OPTIONS,
        prompt: copy.stepReasoning.title,
        selected: state.reasoningLevels ?? [],
        submitStatus: copy.multiSelectSubmit,
        title: copy.stepReasoning.title,
      }),
    };
  }

  // 自由输入步：地址、模型 ID、token 限额、显示名、API Key
  // （模态与推理档位是上面的多选面板，但占着同样的步号，所以这里保留占位项。）
  const steps = [
    copy.stepBaseUrl,
    copy.stepModelId,
    copy.stepTokenLimits,
    copy.stepModalities,
    copy.stepReasoning,
    copy.stepApiKey,
  ];
  const index = Math.min(state.step, 5);
  const spec = steps[index]!;
  const carried =
    state.step === 1
      ? [state.baseUrl!]
      : state.step === 2
        ? [state.baseUrl!, state.modelId!]
        : state.step === 5
          ? [
              ...carriedForModalities,
              modalities.join(",") || "-",
              (state.reasoningLevels ?? []).join(",") || "-",
            ]
          : [];

  return {
    response: `${spec.title}
${spec.help}`,
    selection: {
      emptyMessage: copy.emptyMessage,
      filterable: false,
      help: copy.help,
      items: [
        {
          command: [prefix, ...carried].join(" "),
          id: `${providerId}-${index}`,
          input: {
            cancelStatus: copy.input.cancelStatus,
            clearStatus: copy.input.clearStatus,
            emptyStatus: spec.emptyStatus,
            help: spec.help,
            mask: state.step === 5,
            placeholder: spec.placeholder,
            primary: spec.title,
            secondary: spec.secondary,
            status: copy.input.status,
            submitStatus: copy.input.submitStatus,
          },
          primary: spec.title,
          secondary: spec.secondary,
        },
      ],
      prompt: spec.title,
      title: copy.title,
    },
  };
}

/** 配置成功后的统一回执。 */
export function formatProviderSetupOutcome(result: CommandCenterProviderSetupResult): string {
  return [
    `Configured ${result.templateName} (${result.providerId}).`,
    result.modelId
      ? `Default model for new sessions: ${result.modelId}`
      : "No model on this provider; use /model to add one.",
    "This session has not switched yet — run /model to pick it now, or restart.",
  ].join("\n");
}

/** `/provider rename` 的回执：强调 id 没变，已保存的选型不会失效。 */
export function formatProviderRenameOutcome(result: {
  providerId: string;
  providerName: string;
  previousName?: string;
}): string {
  const from = result.previousName ?? "(unnamed)";
  return [
    `Renamed ${result.providerId}: ${from} → ${result.providerName}`,
    "Provider id is unchanged, so saved model selections and past sessions keep working.",
  ].join("\n");
}
