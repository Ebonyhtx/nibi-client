import { loadBootstrapModule } from "./bootstrap-loader.js";
import { loadCliDotenv } from "./env.js";
import { prepareCliProviderRuntimeEnv } from "./provider-runtime-env.js";
import type { RunDependencies } from "./cli-types.js";
import type {
  CommandCenterProviderRenameResult,
  CommandCenterProviderSetupResult,
  CommandCenterProviderTemplate,
} from "./command-center/types.js";

/**
 * `/provider` 的 Host 侧实现：把 bootstrap 里的 Provider 配置读写接到命令中心。
 *
 * 与 `tui-auth.ts` 的分工：那条是智谱账号登录（已移除），这条与厂商无关 ——
 * 任何内置模板都通过 API Key 配置，不需要账号体系。
 */

type ProviderLocale = "zh-CN" | "en-US";

function providerLocaleOf(locale: string | undefined): ProviderLocale {
  return locale?.startsWith("zh") ? "zh-CN" : "en-US";
}

/**
 * 解析写 Provider 配置时要用的环境。
 *
 * 关键点：写入路径由 `NIBI_BUILTIN_PROVIDER_CONFIG_FILE` 与
 * `NIBI_PERSONAL_PROVIDER_CONFIG_FILE` 决定，而这两个变量**不看**
 * `NIBI_DATA_BASE_DIR`。只用 `NIBI_DATA_BASE_DIR` 做隔离时，写入会落到用户
 * 真实的数据根（实测过：隔离运行把配置写进了 ~/.zcode，覆盖了桌面端正在用的
 * 那份）。所以这里复用 CLI 启动时的同一套解析，把两个路径显式补进 env。
 */
async function prepareProviderEnv(deps: RunDependencies) {
  const env: Record<string, string | undefined> = { ...(deps.env ?? process.env) };
  const workingDirectory = (deps.cwd ?? process.cwd)();
  const dotenvResult = (deps.loadDotenv ?? loadCliDotenv)({ cwd: workingDirectory, env });
  if (dotenvResult.error) {
    throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
      cause: dotenvResult.error,
    });
  }
  const providerEnv = await prepareCliProviderRuntimeEnv({
    argv: process.argv.slice(2),
    env: env as NodeJS.ProcessEnv,
  });
  return { ...env, ...providerEnv };
}

export async function listProviderTemplatesForTui(
  deps: RunDependencies,
  locale: string | undefined,
): Promise<readonly CommandCenterProviderTemplate[]> {
  const env = await prepareProviderEnv(deps);
  const bootstrap = await loadBootstrapModule();
  const templates = await bootstrap.listZCodeProviderTemplates({
    env,
    locale: providerLocaleOf(locale),
  });
  return templates.map((template) => ({
    templateId: template.templateId,
    name: template.name,
    ...(template.baseUrl ? { hint: template.baseUrl } : {}),
  }));
}

export async function setupCustomProviderForTui(
  deps: RunDependencies,
  options: {
    apiKey: string;
    apiType: "anthropic-messages" | "openai-chat-completions" | "openai-responses";
    baseUrl: string;
    contextWindow: number;
    maxOutputTokens: number;
    modalities: readonly string[];
    modelId: string;
    /** 显示名；/model 列表括号里显示它，同时是 provider id 的种子（见 provider 包的 id 生成）。 */
    providerName?: string;
    reasoningLevels: readonly string[];
  },
): Promise<CommandCenterProviderSetupResult> {
  const env = await prepareProviderEnv(deps);
  const bootstrap = await loadBootstrapModule();
  return await bootstrap.setupZCodeCustomProvider({
    ...options,
    env,
    modalities: options.modalities as readonly ("image" | "pdf" | "video")[],
  });
}

/**
 * `/provider rename <providerId> <新名字>`：只改显示名。
 *
 * providerId 不变是硬约束 —— 模型引用、默认选型和历史会话都靠它定位；改名若动了 id，
 * 这些引用会全部失效。
 */
export async function renameProviderForTui(
  deps: RunDependencies,
  options: { providerId: string; providerName: string },
): Promise<CommandCenterProviderRenameResult> {
  const env = await prepareProviderEnv(deps);
  const bootstrap = await loadBootstrapModule();
  return await bootstrap.renameZCodeProvider({
    env,
    providerId: options.providerId,
    providerName: options.providerName,
  });
}

export async function setupProviderForTui(
  deps: RunDependencies,
  options: { apiKey: string; locale?: string; templateId: string },
): Promise<CommandCenterProviderSetupResult> {
  const env = await prepareProviderEnv(deps);
  const bootstrap = await loadBootstrapModule();
  return await bootstrap.setupZCodeProvider({
    apiKey: options.apiKey,
    env,
    locale: providerLocaleOf(options.locale),
    templateId: options.templateId,
  });
}
