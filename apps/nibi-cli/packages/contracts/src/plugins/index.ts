import type { CustomCommandRoot } from "../commands/index.js";
import type {
  HookMatcherConfig,
  PluginHookEventName,
} from "../hooks/index.js";
import type { McpServerConfig } from "../interfaces/mcp.port.js";
import type { SkillRoot } from "../skills/index.js";
import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";
import type { PluginAcceptanceContract, PluginAcceptanceParseResult } from "./acceptance.js";

export type {
  PluginAcceptanceActivation,
  PluginAcceptanceCheck,
  PluginAcceptanceCheckKind,
  PluginAcceptanceContract,
  PluginAcceptanceParseResult,
  PluginAcceptanceStage,
  PluginAcceptanceVariables,
} from "./acceptance.js";
export {
  PLUGIN_ACCEPTANCE_VERSION,
  acceptanceChecksForStage,
  acceptanceTemplateVariables,
  describeWorkspaceRelativePathProblem,
  expandAcceptanceTemplate,
  isPluginAcceptanceUsable,
  parsePluginAcceptance,
} from "./acceptance.js";

// NIBI：官方市场 id 为自有市场；上游为 `nibi-official`。
export const NIBI_OFFICIAL_PLUGIN_MARKETPLACE = "nibi-official";
export const CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE = "claude-plugins-official";
export const NIBI_INLINE_PLUGIN_MARKETPLACE = "inline";
export const NIBI_PLUGIN_HOST_COMMAND = "__nibi-plugin-host";
/**
 * 隐藏子命令：dynamic workflow 的沙箱子进程入口（`__nibi-dwf-child <entry path>`；argv 末位是
 * harness 写好的入口文件路径，payload 不过命令行）。
 *
 * 与 {@link NIBI_PLUGIN_HOST_COMMAND} 同族、同机制：SEA 单文件二进制不解释 Node CLI 旗标，
 * 于是 harness 默认的 `node --max-old-space-size=… <entry>` spawn 在 SEA 下会把旗标交给严格
 * parseArgs 而必然失败。SEA 下改为自 re-exec 本二进制并由 `run.ts` 在 parseArgs **之前**分派。
 * 常量放在 contracts 而非 dynamic-workflow-runtime：后者刻意不依赖 contracts（app-free 证明），
 * 由 bootstrap 在 SEA 判定后把它作为 argsPrefix 递给 harness。
 */
export const NIBI_DWF_CHILD_COMMAND = "__nibi-dwf-child";

export function isOfficialMarketplaceId(id: string): boolean {
  return id === NIBI_OFFICIAL_PLUGIN_MARKETPLACE || id === CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE;
}

export type PluginSource = "official" | "inline" | "cache";
export type PluginDiagnosticSeverity = "warning" | "error";

export type PluginDiagnosticCode =
  | "plugin_root_not_found"
  | "plugin_manifest_not_found"
  | "plugin_manifest_invalid"
  | "plugin_component_path_invalid"
  | "plugin_unsupported_component"
  | "plugin_skill_root_empty"
  | "plugin_mcp_read_failed"
  | "plugin_mcp_invalid"
  | "plugin_mcp_server_disabled"
  | "plugin_hook_read_failed"
  | "plugin_hook_invalid"
  | "plugin_hook_unsupported_event"
  | "plugin_dependency_invalid"
  | "plugin_dependency_missing"
  | "plugin_dependency_cycle"
  | "plugin_dependency_cross_marketplace"
  | "plugin_marketplace_invalid"
  | "plugin_marketplace_declaration_reserved"
  | "plugin_git_unavailable"
  | "plugin_archive_fetch_failed"
  | "plugin_marketplace_source_unsupported"
  | "plugin_validation_deferred"
  | "plugin_variable_missing"
  | "plugin_duplicate_id"
  | "plugin_not_found"
  | "plugin_ambiguous_name"
  | "plugin_membership_required"
  | "plugin_capability_leak_pruned"
  | "plugin_capability_unsupported"
  | "plugin_capability_consent_required"
  | "plugin_runtime_invalid"
  | "plugin_consent_required"
  | "plugin_acceptance_invalid"
  | "plugin_acceptance_weak"
  /** 命中了签名撤销列表的 block 条目：文件保留，但不再加载/执行。 */
  | "plugin_revoked"
  /** 命中撤销列表的 warn 条目：加载但提示（与 block 分开，UI 不能显示成「已停用」）。 */
  | "plugin_revocation_warning"
  /** 撤销列表刷新失败（网络/验签/回退）；沿用上一份成功快照。 */
  | "plugin_revocation_refresh_failed"
  /** 磁盘内容与同意时绑定的包 hash 不一致：声明式组件仍可用，代码不激活。 */
  | "plugin_package_hash_mismatch"
  /** 包内存在原生模块但清单未声明 `runtime.native`。 */
  | "plugin_native_module_blocked"
  /** 原生模块声明的平台/ABI 与当前宿主运行时不一致。 */
  | "plugin_runtime_abi_mismatch"
  /** 官方/内置插件包内自带 Node 运行时（只允许 local 插件自带，见计划 §8.5）。 */
  | "plugin_bundled_runtime_forbidden"
  /** 本地/第三方代码插件缺少绑定包 hash 的信任记录。 */
  | "plugin_trust_required"
  /** 安装记录已进入 removed 墓碑期（保留数据，不再加载）。 */
  | "plugin_removed"
  /** view root 无法建立等价视图：已回退读插件源目录（功能不受影响，但未隔离）。 */
  | "plugin_view_root_unavailable";

export interface PluginUserConfigOption {
  default?: string | number | boolean;
  description?: string;
  title?: string;
  required?: boolean;
  sensitive?: boolean;
  type?: "string" | "number" | "boolean" | "directory" | "file";
}

export type PluginOptionValue = string | number | boolean;
export type PluginOptionValues = Record<string, PluginOptionValue>;

export type PluginMarketplaceSourceConfig =
  | { source: "url"; headers?: Record<string, string>; url: string }
  | { path?: string; ref?: string; repo: string; source: "github"; sparsePaths?: string[] }
  | { path?: string; ref?: string; source: "git"; sparsePaths?: string[]; url: string }
  | { package: string; source: "npm" }
  | { source: "file"; path: string }
  | { source: "directory"; path: string };

export interface PluginMarketplaceConfig {
  source: PluginMarketplaceSourceConfig;
}

export interface PluginHookDetail {
  args?: string[];
  async?: boolean;
  command: string;
  event: PluginHookEventName;
  matcher?: string;
  runnable: boolean;
  shell?: true | string;
  sourcePath: string;
  statusMessage?: string;
  timeout?: number;
  timeoutMs?: number;
  type: "command" | "process";
}

/** 详情 UI 的组件分组类型，顺序与展示一致：agent / command / skill / hook / mcp。 */
export type PluginComponentKind = "agent" | "command" | "skill" | "hook" | "mcp";

export interface PluginComponentItem {
  name: string;
  /** 来自组件 frontmatter / manifest 的描述；缺失时省略，绝不伪造。 */
  description?: string;
}

export interface PluginComponentGroup {
  kind: PluginComponentKind;
  items: PluginComponentItem[];
}

/**
 * 商店信息（Store Listing）：市场目录条目携带的展示性元数据，描述"如何在商店里呈现"，
 * 不影响插件功能。字段全部可选，缺失时 UI 按降级矩阵处理（字母头像 / 隐藏区块 / 省略信息行）。
 */
export interface PluginStoreListing {
  /** 卡片/详情显示名，缺失回退插件 name slug。 */
  displayName?: string;
  displayNameI18n?: Record<string, string>;
  /** 目录条目描述的多语言版本（description 本体已有独立字段）。 */
  descriptionI18n?: Record<string, string>;
  /** icon 图片：https URL 或内置插件的本地资源路径。 */
  icon?: string;
  category?: string;
  /** 官方市场内的维护归属；不参与执行权限和安装来源判定。 */
  publisherType?: "official" | "community";
  author?: string;
  authorUrl?: string;
  homepage?: string;
  privacyPolicy?: string;
  termsOfService?: string;
  /** 详情页 hero 横幅图。 */
  heroImage?: string;
  /** 详情页示例提示词胶囊；点击后新建会话预填。 */
  examplePrompts?: string[];
  examplePromptsI18n?: Record<string, string[]>;
  /**
   * 需要付费套餐才好用：目录条目声明 `requiresPaidPlan: true`，商店卡片与详情页
   * 标题右侧展示提示图标。表达「使用条件」，不代表插件本身是收费商品，
   * 因此不参与安装门禁与计费；命名不绑定具体套餐商品名，套餐改名不会让字段过期。
   */
  requiresPaidPlan?: boolean;
}

export interface PluginManifest {
  /** 声明式验收合同；形状与语义见 ./acceptance.ts。未声明＝沿用宿主通用完成判定。 */
  acceptance?: unknown;
  agents?: unknown;
  author?: unknown;
  channels?: unknown;
  commands?: unknown;
  dependencies?: unknown;
  description?: string;
  homepage?: string;
  hooks?: unknown;
  keywords?: unknown;
  license?: string;
  lspServers?: unknown;
  mcpServers?: unknown;
  name: string;
  outputStyles?: unknown;
  /** 插件申请的 NIBI Extension 能力（`nibi.*`）；由适配器归一化为 capability profile。 */
  capabilities?: unknown;
  /** 插件申请的能力；由适配器归一化为 `PluginPermissionProfile`。 */
  permissions?: unknown;
  repository?: string;
  /** 扩展代码入口；由适配器归一化为 `PluginRuntimeDeclaration`。 */
  runtime?: unknown;
  settings?: unknown;
  skills?: unknown;
  /** 插件 UI：`ui.surfaces[]` 面板入口声明，adapters 解析。 */
  ui?: unknown;
  userConfig?: Record<string, PluginUserConfigOption>;
  version?: string;
}

/**
 * 插件包清单的生态归属。内部 id，只允许出现在适配器层与诊断数据里。
 * 顺序即发现特异性：native > agent-plugins > claude > codex > zcode > dsh。
 */
export type PluginAdapterId =
  | "native"
  | "agent-plugins"
  | "claude"
  | "codex"
  | "zcode"
  | "dsh";

/**
 * 兼容级别，只进数据层与诊断，UI 不展示级别本身：
 * - `full`：清单声明的组件当前全部可运行；
 * - `partial`：至少一个声明组件只识别、不运行（原因见 `skipped`）；
 * - `detected`：只能识别包，不能运行任何组件（L0）。
 */
export type PluginCompatibilityLevel = "full" | "partial" | "detected";

/**
 * 信任来源。P0/P1 只随元数据下发；真正的授权与撤销在能力网关（P2）落地。
 * - builtin：随客户端分发的内置插件；
 * - official：NIBI 官方市场（签名清单 + 单调 revision）；
 * - community：第三方市场安装；
 * - local：用户本地目录（`plugins.dirs`、导入、开发中的插件）。
 */
export type PluginTrustLevel = "builtin" | "official" | "community" | "local";

/** 来自其他 agent 工具生态的适配器；包清单可读，但身份仍归一到 `<name>@<marketplace>`。 */
export type PluginExternalAdapterId = "claude" | "codex" | "zcode" | "dsh";

/**
 * 派生的插件来源，仅供展示与诊断。canonical id 仍是唯一身份，
 * 本字段不参与鉴权、能力同意、付费门禁或持久化键。
 */
export type PluginOrigin =
  | "builtin"
  | "official"
  | "community"
  | "local"
  | `external:${PluginExternalAdapterId}`;

const EXTERNAL_PLUGIN_ADAPTER_IDS: ReadonlySet<PluginAdapterId> = new Set([
  "claude",
  "codex",
  "zcode",
  "dsh",
]);

function isPluginExternalAdapterId(
  adapterId: PluginAdapterId,
): adapterId is PluginExternalAdapterId {
  return EXTERNAL_PLUGIN_ADAPTER_IDS.has(adapterId);
}

/**
 * 计算派生的插件来源：内置优先；外来生态适配器标记为 `external:<adapterId>`；
 * 其余按发现信任等级原样返回。纯函数，不读取路径或持久化状态。
 */
export function resolvePluginOrigin(
  trust: PluginTrustLevel,
  adapterId: PluginAdapterId,
): PluginOrigin {
  if (trust === "builtin") return "builtin";
  return isPluginExternalAdapterId(adapterId) ? `external:${adapterId}` : trust;
}

/**
 * 插件可申请的 NIBI 能力。闭集；未声明 = 不申请。
 * `filesystem.*` / `network` / `process` 的授予规则见 P2 能力网关。
 */
export type PluginPermission =
  | "filesystem.read"
  | "filesystem.write"
  | "network"
  | "process"
  | "code"
  | "full-access";

export interface PluginPermissionProfile {
  /** 清单声明的能力（请求值，不等于授权值）。 */
  requested: PluginPermission[];
  /** 运行时实际需要的能力（由组件推导 + 清单请求并集）；空数组 = 无需同意。 */
  required: PluginPermission[];
}

/** NIBI Extension API v1 能力闭集（与插件架构 B §3.1 一致）。 */
export const PLUGIN_CAPABILITY_IDS = [
  "nibi.sessions.read",
  "nibi.workspace.files.read",
  "nibi.ui.view",
  "nibi.settings.own",
  "nibi.notifications.show",
] as const;

export type PluginCapabilityId = (typeof PLUGIN_CAPABILITY_IDS)[number];

export type PluginCapabilityScope = "workspace" | "project" | "host";

export interface PluginCapabilityGrant {
  id: PluginCapabilityId;
  scope: PluginCapabilityScope;
}

export interface PluginCapabilityProfile {
  /** 清单请求的 (能力, 作用域)；host 作用域只对官方/内置生效。 */
  requested: PluginCapabilityGrant[];
  /** 已持久化的授权（未同意时为空的敏感能力）。 */
  granted: PluginCapabilityGrant[];
}

/** 扩展代码入口；`node`/`native` 只做运行时兼容提示，不代装 Node。 */
export interface PluginRuntimeDeclaration {
  apiVersion: "1";
  entry: string;
  native?: boolean;
  napi?: number;
  node?: string;
  platforms?: string[];
}

/** 适配器归一化后写入的元数据；产品面不展示 `adapterId`。 */
export interface PluginAdapterInfo {
  adapterId: PluginAdapterId;
  /** 相对插件根的清单路径，统一用 `/` 分隔。 */
  manifestPath: string;
  compatibility: PluginCompatibilityLevel;
  /** 已识别但当前版本不运行的声明组件，例如 `lspServers`、`apps`、`cordis`。 */
  skipped: string[];
}

/**
 * 内部唯一模型：任何生态的清单先由适配器归一化为 `CanonicalPlugin`，
 * 核心只消费这一个形状。`manifest` 是归一化后的字段集合（NIBI 扩展已摊平），
 * `adapter` 记录来源与损失，`permissions` 保留插件请求值。
 */
export interface CanonicalPlugin {
  adapter: PluginAdapterInfo;
  manifest: PluginManifest;
  permissions: PluginPermissionProfile;
  rootPath: string;
  trust: PluginTrustLevel;
}

/** 面板生命周期：第一版只接受会话级；`draft` 留待需要时放开。 */
export type PluginUiSurfaceAvailability = "session";
/** 声明式插槽锚点：第一版只开放 composer 状态条与主导航。 */
export type PluginUiSlot = "composer.status" | "nav.primary";
/** 标题：单一字符串或按 locale 键的映射（`{ "zh-CN": "...", "en-US": "..." }`）。 */
export type PluginUiSurfaceTitle = string | Record<string, string>;
export interface PluginUiSurfaceDefinition {
  id: string;
  title: PluginUiSurfaceTitle;
  icon?: string;
  /** 运行时 namespaced MCP server 名（`plugin:${name}:${server}`），UI 直接用它调 mcp/uiReadResource。 */
  server: string;
  /** 清单里声明的原始 server 键，仅供诊断与展示。 */
  declaredServer: string;
  /** 必须以 `ui://` 开头。 */
  resourceUri: string;
  availability: PluginUiSurfaceAvailability;
  /** 声明式插槽锚点；缺省 = 只在启动器/标签页里出现。 */
  slot?: PluginUiSlot;
}

export interface PluginConfig {
  dirs: string[];
  enabled: boolean;
  enabledPlugins: Record<string, boolean>;
  extraKnownMarketplaces: Record<string, PluginMarketplaceConfig>;
  options: Record<string, PluginOptionValues>;
  suppressedBuiltins: string[];
}

export interface PluginMetadata {
  /**
   * 已解析的验收合同。仅当 manifest.acceptance 存在**且**校验通过时才有值；
   * 校验失败时在 acceptanceDiagnostics 里给出原因，而不是静默降级成「无门禁」。
   */
  acceptance?: PluginAcceptanceContract;
  /** acceptance 的解析结果（致命问题与非致命提醒），供插件详情与宿主日志消费。 */
  acceptanceDiagnostics?: PluginAcceptanceParseResult;
  /** 实际读取该插件的适配器与兼容性（P0 只进数据层，不展示生态名）。 */
  adapter: PluginAdapterInfo;
  /** manifest（plugin.json）里的作者名，规范化为字符串；商店信息缺失时作为详情页回退。 */
  author?: string;
  authorUrl?: string;
  commandRootCount: number;
  /**
   * 权威的组件清单（名称 + 可选描述），由 loader 在解析阶段对插件根目录枚举得出，
   * 与启用态无关。详情 UI 直接展示，无需再在 UI 侧 join Skills/Commands/Agents。
   */
  components: PluginComponentGroup[];
  configuredOptions?: PluginOptionValues;
  dataPath: string;
  declaredMcpServerNames: string[];
  description?: string;
  enabled: boolean;
  /** manifest（plugin.json）homepage；商店信息缺失时作为详情页回退。 */
  homepage?: string;
  id: string;
  manifestPath: string;
  marketplace: string;
  mcpServerNames: string[];
  name: string;
  hookDetails: PluginHookDetail[];
  /** 清单声明的能力请求（不等同于已授权）。 */
  permissions: PluginPermissionProfile;
  /** NIBI Extension API 能力请求与已授权集合。 */
  capabilities: PluginCapabilityProfile;
  /** 扩展代码声明；未声明时缺省。 */
  runtime?: PluginRuntimeDeclaration;
  rootPath: string;
  skillCount: number;
  skillRootCount: number;
  source: PluginSource;
  /** 派生的来源（信任等级 + 适配器生态），仅供展示与诊断；不参与身份判定与门禁。 */
  origin: PluginOrigin;
  /**
   * 完整性门禁拦下的原因。有值时插件不进入运行面（声明式组件与代码都不加载），
   * UI 用它显示「已停用/已撤销/已停止分发」而不是把插件当成普通未启用。
   */
  blockedReason?: { code: PluginDiagnosticCode; message: string };
  /**
   * 只管住扩展代码（`runtime.entry`）的原因。声明式组件（skills/commands/agents/
   * hooks/MCP 声明）仍然可用——原生模块 ABI 不匹配、包 hash 与同意不一致属于
   * 「代码不能跑」，不是「插件不能用」。
   */
  codeBlockedReason?: { code: PluginDiagnosticCode; message: string };
  /** 发现时计算/记录的包内容 hash（`sha256:<hex>`）；声明式内置插件可能缺省。 */
  packageHash?: string;
  /** 发现来源的信任等级；P2 能力网关按它决定可授予上限。 */
  trust: PluginTrustLevel;
  /** 清单 `ui.surfaces[]` 解析结果（已校验）；未声明或全部非法时缺省。 */
  uiSurfaces?: PluginUiSurfaceDefinition[];
  userConfig?: Record<string, PluginUserConfigOption>;
  version?: string;
}

export interface PluginDiagnostic {
  code: PluginDiagnosticCode;
  message: string;
  path?: string;
  pluginId?: string;
  severity: PluginDiagnosticSeverity;
}

// ============================================================
// Plugin 对话引用（@ Plugin capability hint）的身份 catalog 契约。
// 语义：catalog 在 Session（App）创建时冻结，
// 只承载身份与能力"声明"；实际注入能力每轮与 live inventory 取交集。
// ============================================================

export interface PluginReferenceCatalogEntry {
  /** 稳定 Plugin ID：`${manifest.name}@${marketplace}`，canonical plugin:// 链接的唯一身份。 */
  pluginId: string;
  /** manifest name（Skill/MCP/Subagent runtime 名字空间的基），仅用于展示与 provenance 匹配，不具权威性。 */
  name: string;
  marketplace: string;
  /** catalog 冻结时刻的启用态；disabled 条目保留用于 `disabled_in_session` 诊断，不可被引用。 */
  enabled: boolean;
  /**
   * 与本条目共享 manifest.name 的其他 enabled Plugin stable IDs。
   * 非空即 V1 fail closed 冲突：Picker 禁选、runtime 按 ambiguous 跳过，
   * 禁止 last-write-wins 或 display name 猜测。
   */
  conflictingPluginIds: string[];
  /** 身份声明的 Skill qualified names（`${name}:${skill}`）；来自组件枚举，与 live 发现解耦。 */
  skillQualifiedNames: string[];
  /** 身份声明的 namespaced MCP server names（`plugin:${name}:${server}`）。 */
  mcpServerNames: string[];
  /** 身份声明的 canonical Subagent names（`${name}:${agent}`）；来自组件枚举。 */
  subagentNames: string[];
  /**
   * Plugin 根目录，仅供 runtime 对 live Skill/Subagent 做 provenance 回溯（rootPath 前缀判定）。
   * 禁止进入 provider reminder 或协议投影——路径不属于 identifiers-only 契约。
   */
  rootPath: string;
  /** 面板入口声明（A5）；供 host 在 session 冻结 catalog 里查面板定义。 */
  uiSurfaces?: PluginUiSurfaceDefinition[];
}

export interface PluginReferenceCatalog {
  plugins: PluginReferenceCatalogEntry[];
}

export interface PluginLoadOutcome {
  commandRoots: CustomCommandRoot[];
  diagnostics: PluginDiagnostic[];
  hooks: Partial<Record<PluginHookEventName, HookMatcherConfig[]>>;
  mcpServers: Record<string, McpServerConfig>;
  /** 商店 listing 按完整 Plugin ID 关联，供 CLI/TUI 展示；不参与运行时身份判断。 */
  pluginListingsById?: Record<string, PluginStoreListing>;
  plugins: PluginMetadata[];
  skillRoots: SkillRoot[];
}

/** 付费插件门禁的入参：插件身份三元组，不含本机路径。 */
export interface PaidPluginGateInput {
  id: string;
  marketplace: string;
  name: string;
}

export type PaidPluginGateResult =
  | { allowed: true }
  | { allowed: false; code?: PluginDiagnosticCode; message?: string };

export interface PluginDiscoverRequest {
  config: PluginConfig;
  env?: Record<string, string | undefined>;
  // bootstrap 可以把"安全到默认就开"的 official plugin id 列表传进来,
  // 让用户不必先 `nibi plugins enable` 就能用 (例如纯内容型的 skill-creator)。
  // 默认空集合, 现有 plugin (含 ios-simulator/android-emulator 这种重负载) 行为不变。
  officialPluginsEnabledByDefault?: ReadonlySet<string>;
  officialPluginRoots?: string[];
  /**
   * 付费插件运行时门禁：返回 allowed=false 的插件按未启用处理，其 mcp/hooks/
   * skill/command 能力根全部不进入发现结果。未提供时 adapter 使用内置 license
   * 门禁（fail-closed）；只有确知无需裁剪的调用方才显式传放行函数。
   */
  paidPluginGate?: (plugin: PaidPluginGateInput) => PaidPluginGateResult;
  storageRoot: string;
  trace?: TraceContext;
  workingDirectory: string;
}

export interface PluginOperationOptions {
  context?: ExecutionContext;
  signal?: AbortSignal;
}

export interface PluginPort {
  discoverPlugins(
    request: PluginDiscoverRequest,
    options?: PluginOperationOptions,
  ): Promise<PluginLoadOutcome>;
}
