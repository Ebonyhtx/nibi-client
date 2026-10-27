import type {
  AccountProviderConnectionResolver,
  AccountProviderConnectionResult,
  ProviderConfigSnapshot,
  ProviderSource,
} from "@nibi/provider";
import { AccountProviderService, createAccountProviderConfigResolver } from "@nibi/provider";
import type {
  ProviderFamilyConnectionSelectionSettings,
  ProviderFamilyDomain,
  ZCodeAccountAccess,
  ZCodeProviderAccountAccess,
} from "@nibi/shared";

export interface AccountProviderConnectionSettings {
  readonly providerFamilyDomain: ProviderFamilyDomain | null;
  readonly selections: ProviderFamilyConnectionSelectionSettings;
  /** Host 旧连接导入尚不能确定身份；仅运行时事实，不写入配置或协议。 */
  readonly unresolvedFamilies?: readonly ProviderFamilyDomain[];
}

export interface AccountProviderConnectionResolverOptions {
  readonly readSettings: () => Promise<AccountProviderConnectionSettings>;
  readonly loadAccountIdentity: (family: ProviderFamilyDomain) => Promise<string | null>;
}

export interface AccountProviderConfigSourceOptions extends AccountProviderConnectionResolverOptions {
  readonly configSource: ProviderSource<ProviderConfigSnapshot>;
}

/**
 * 上游 Coding Plan / Team Plan 业务线已移除。账号型 Provider 不再有可解析的套餐权益，
 * 统一发布为 unavailable；标准 API Key Provider 不经过这里。
 */
export function createAccountProviderConnectionResolver(
  options: AccountProviderConnectionResolverOptions,
): AccountProviderConnectionResolver {
  return async ({ configuredProviders }) => {
    const settings = await options.readSettings();
    const connections: AccountProviderConnectionResult[] = [];
    for (const [providerId, config] of configuredProviders.entries()) {
      if (config.access?.type !== "zhipu-account") continue;
      const identity = config.access.accountType
        ? await options.loadAccountIdentity(config.access.accountType)
        : null;
      connections.push({
        providerId,
        status: "unavailable",
        unavailableReason: identity?.trim() ? "not-entitled" : "not-connected",
        current:
          Boolean(config.access.accountType) &&
          settings.providerFamilyDomain === config.access.accountType &&
          Boolean(identity?.trim()),
      });
    }
    return Object.freeze(connections);
  };
}

/** 组装 Config、账号连接解析与第三层 Account Provider Config Source。 */
export function createAccountProviderConfigSource(
  options: AccountProviderConfigSourceOptions,
): AccountProviderService {
  return new AccountProviderService({
    configSource: options.configSource,
    resolve: createAccountProviderConfigResolver(createAccountProviderConnectionResolver(options)),
  });
}

/**
 * 把 Active Model 的静态 Access 约束投影到当前账号连接。
 *
 * Team scope 和账号版本不能冻结进 Model：账号切换后旧 Model 会错误失效。
 * 每次请求重新读取当前选择；只有 family 与 mode 兼容时才返回动态访问事实。
 */
export async function resolveCurrentAccountAccess(input: {
  readonly access: ZCodeProviderAccountAccess;
  readonly readSettings: () => Promise<AccountProviderConnectionSettings>;
  readonly loadAccountIdentity: (family: ProviderFamilyDomain) => Promise<string | null>;
}): Promise<ZCodeAccountAccess | null> {
  const settings = await input.readSettings();
  const { accountType, mode } = input.access;
  if (settings.providerFamilyDomain !== accountType) return null;
  if (mode === "start-plan") {
    if (!(await input.loadAccountIdentity(accountType))?.trim()) return null;
    return { type: "zhipu-account", family: accountType, planKind: "start-plan" };
  }
  const selection = settings.selections[accountType];
  if (!selection) return null;
  if (selection.kind !== mode) return null;
  if (!(await input.loadAccountIdentity(accountType))?.trim()) return null;
  if (selection.kind === "team-coding-plan") {
    return {
      type: "zhipu-account",
      family: accountType,
      planKind: selection.kind,
      productId: selection.productId,
      organizationId: selection.organizationId,
      projectId: selection.projectId,
    };
  }
  return {
    type: "zhipu-account",
    family: accountType,
    planKind: selection.kind,
  };
}
