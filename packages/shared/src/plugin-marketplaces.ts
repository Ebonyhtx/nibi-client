export interface DefaultPluginMarketplace {
  id: string;
  source: string;
  name: string;
  description: string;
  pluginCount: number;
  lastUpdated?: string;
}

export const NIBI_OFFICIAL_PLUGIN_MARKETPLACE_ID = "nibi-official";

/**
 * Claude Code 官方市场（GitHub git 源）。它不是 ZCode 的强依赖：GitHub 不可达时刷新必然失败，
 * 该失败不应作为错误提示打扰用户，UI 侧按此 id 静默处理其刷新失败（任何原因）。
 */
export const CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE_ID = "claude-plugins-official";

/** Settings 三类资源发现共用；Bootstrap 单测与官方 definition 的 defaultEnabled 机械对照。 */
export const DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS: ReadonlySet<string> = new Set([
  "browser-use@nibi-official",
  "documents@nibi-official",
  "pdf@nibi-official",
  "presentations@nibi-official",
  "spreadsheets@nibi-official",
  // node_repl 宿主：不进市场、不对用户露出，也不贡献任何 skill/command/subagent，但必须
  // 始终可用 —— node_repl 的注册门禁是「Browser Use 或 Computer Use 任一启用」，宿主自己
  // 不参与那个判断。Browser Use 默认开着，宿主若默认关就等于它上来就没有宿主。
  "node-repl-host@nibi-official",
  "skill-creator@nibi-official",
  "plugin-creator@nibi-official",
  "zcode-guide@nibi-official",
  // 上游新增：visualize（交互视图）随 UI 插件合入时 CLI 定义已标 defaultEnabled，但这里漏加，
  // Settings 会把它当成默认关闭，与 CLI 实际启用状态不一致。
  "visualize@nibi-official",
  // 电脑控制回退为默认关闭，故 computer-use 不在此名单内。
  // 该集合必须与 official-plugin-definitions.ts 里标了 defaultEnabled 的插件逐一对应，
  // bootstrap 的「Settings 默认启用集合与 CLI 的官方插件声明一致」单测机械对照两者。
]);

/**
 * **暂时隐藏的默认市场**（NIBI fork，2026-10-17 用户决定 3）。
 *
 * 上游为兼容 Claude Code 生态带进来一个 git 源市场（`anthropics/claude-plugins-official`）。
 * NIBI 客户端**只保留自己的市场**（用户明确不要"打开插件市场看到好几个市场"的形态），
 * 所以这条默认条目暂不启用：不再 seed，已存在的、且**来源与我们这条默认定义一致**的记录也会被摘掉
 * （判据比来源形状，不比 id 名字——用户手工添加的同名源不受影响）。
 *
 * 后续有精力再决定收编 / 过滤 / 保留：**重新启用只需把这个 id 从这里删掉**，下面的定义保持原样。
 */
export const HIDDEN_DEFAULT_PLUGIN_MARKETPLACE_IDS: ReadonlySet<string> = new Set([
  CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
]);

const ALL_DEFAULT_PLUGIN_MARKETPLACES: readonly DefaultPluginMarketplace[] = [
  {
    // NIBI 官方唯一市场：本地 seed 分片与远端清单分片在 Agent storage 内合并。
    // 远端 manifest 的 name 必须与该 canonical id 一致；清单与配套 .sig 由 NIBI 服务端发布。
    id: NIBI_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    source: "https://api.nibistudio.top/plugins/marketplace.json",
    name: NIBI_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    description: "NIBI 官方插件市场：内置与社区插件。",
    pluginCount: 0,
  },
  {
    id: CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    source: "anthropics/claude-plugins-official",
    name: CLAUDE_OFFICIAL_PLUGIN_MARKETPLACE_ID,
    description:
      "Directory of popular Claude Code extensions including development tools, productivity plugins, and MCP integrations",
    // 只内置官方 catalog 来源，不把远端 manifest 快照打包进仓库；首次刷新前数量未知。
    pluginCount: 0,
  },
];

/** 对外的默认清单：过滤掉被隐藏的条目（见 HIDDEN_DEFAULT_PLUGIN_MARKETPLACE_IDS）。 */
export const DEFAULT_PLUGIN_MARKETPLACES: DefaultPluginMarketplace[] =
  ALL_DEFAULT_PLUGIN_MARKETPLACES.filter(
    (marketplace) => !HIDDEN_DEFAULT_PLUGIN_MARKETPLACE_IDS.has(marketplace.id),
  );

/**
 * 隐藏条目的完整定义（含 source）。
 * 消费方用它判断"磁盘上这条记录要不要摘"：id 相同 **且** 来源与我们定义一致才摘，
 * 这样用户手工添加的同名源不会被误删。
 */
export function hiddenDefaultPluginMarketplaces(): readonly DefaultPluginMarketplace[] {
  return ALL_DEFAULT_PLUGIN_MARKETPLACES.filter((marketplace) =>
    HIDDEN_DEFAULT_PLUGIN_MARKETPLACE_IDS.has(marketplace.id),
  );
}

// 商店「公开」分段只有一个 NIBI 官方市场 id，内置与远端分片不再拆分身份。
export const PUBLIC_STORE_MARKETPLACE_IDS = [NIBI_OFFICIAL_PLUGIN_MARKETPLACE_ID] as const;

export function isPublicStoreMarketplaceId(id: string): boolean {
  return (PUBLIC_STORE_MARKETPLACE_IDS as readonly string[]).includes(id);
}

// ── 插件清单目录（包格式） ─────────────────────────────────────────────────
//
// 插件包 = 一个目录，里面必须有一个 `<清单目录>/plugin.json`。宿主按下面的顺序探测，
// 命中第一个存在的即用；这是**互操作层**，不是品牌标识：
//   .nibi-plugin    ← NIBI 自有格式（我们的内置件与市场上架件都迁到这里）
//   .zcode-plugin   ← 上游 ZCode 格式：已发布的第三方包仍用它，保留读取
//   .claude-plugin  ← Claude 插件生态
//   .codex-plugin   ← Codex 插件生态
//
// 顺序有意义：同名目录并存时优先读 NIBI 的，避免重打包前后的两个清单互相打架。
export const NIBI_PLUGIN_MANIFEST_DIR = ".nibi-plugin";
export const ZCODE_PLUGIN_MANIFEST_DIR = ".zcode-plugin";
export const CLAUDE_PLUGIN_MANIFEST_DIR = ".claude-plugin";
export const CODEX_PLUGIN_MANIFEST_DIR = ".codex-plugin";

/** 按发现优先级排列的清单目录；第一个是 NIBI 自己的写入格式。 */
export const PLUGIN_MANIFEST_DIRS = [
  NIBI_PLUGIN_MANIFEST_DIR,
  ZCODE_PLUGIN_MANIFEST_DIR,
  CLAUDE_PLUGIN_MANIFEST_DIR,
  CODEX_PLUGIN_MANIFEST_DIR,
] as const;
