/**
 * 项目级配置文件（`nibi.json`、`.nibi/config.json`）的键白名单（PROJECT-CONFIG）。
 *
 * 项目文件来自工作区，属于不可信输入：只放行已经存在独立信任门禁、且只是声明的能力。
 * - `hooks`：工作区 Hook 信任（candidate side-channel，未信任不执行）。
 * - `mcp`：工作区 MCP 信任（docs/specs/workspace-mcp-trust.md）。
 * - `plugins.dirs`：项目内插件目录；解析后必须落在工作区根之内，越界项丢弃并记
 *   `plugins.dirs[i]` 诊断。
 * - `plugins.enabledPlugins`：只允许 `false`（禁用）；`true` 由仓库写进来等于给已安装插件放权，丢弃。
 * - `plugins.options`：按插件 manifest 的 `userConfig` schema 消费，不在配置层自由透传。
 *
 * 权限、存储、网络、模型流、功能开关、skills/commands、日志、UI 等键一律不向项目层开放；
 * 以后新增的键缺省也不开放。canonical 清单是同目录的 `project-config.keys.json`：
 * Node mirror 在本文件，Rust mirror 在 `kernel/crates/cli/src/config/project_scope.rs`，两侧都有
 * conformance 测试核对该 JSON。
 */

export const PROJECT_CONFIG_ALLOWED_TOP_LEVEL_KEYS = ["hooks", "mcp", "plugins"] as const;

export const PROJECT_CONFIG_IGNORED_TOP_LEVEL_KEYS = [
  "$schema",
  "askUserQuestionTimeout",
  "checkForUpdateOnStartup",
  "command",
  "commandOverrides",
  "features",
  "logging",
  "memory",
  "modelAnomalyGuard",
  "modelStream",
  "network",
  "permission",
  "skill",
  "skillOverrides",
  "skills",
  "storage",
  "toolConcurrency",
  "ui",
] as const;

export const PROJECT_CONFIG_ALLOWED_PLUGIN_KEYS = ["dirs", "enabledPlugins", "options"] as const;

export const PROJECT_CONFIG_IGNORED_PLUGIN_KEYS = [
  "enabled",
  "extraKnownMarketplaces",
  "suppressedBuiltins",
] as const;

/** 项目层可以出现的顶层键。 */
export type ProjectConfigAllowedTopLevelKey =
  (typeof PROJECT_CONFIG_ALLOWED_TOP_LEVEL_KEYS)[number];

/** 项目层可以出现的 `plugins` 子键。 */
export type ProjectConfigAllowedPluginKey = (typeof PROJECT_CONFIG_ALLOWED_PLUGIN_KEYS)[number];

/** 项目层整段丢弃的顶层键。 */
export type ProjectConfigIgnoredTopLevelKey =
  (typeof PROJECT_CONFIG_IGNORED_TOP_LEVEL_KEYS)[number];

/** 项目层整段丢弃的 `plugins` 子键。 */
export type ProjectConfigIgnoredPluginKey = (typeof PROJECT_CONFIG_IGNORED_PLUGIN_KEYS)[number];

/** 项目层能生效的完整键路径。 */
export type ProjectConfigAllowedKeyPath =
  | "hooks"
  | "mcp"
  | "plugins.dirs"
  | "plugins.enabledPlugins"
  | "plugins.options";

export function isProjectConfigTopLevelKeyAllowed(
  key: string,
): key is ProjectConfigAllowedTopLevelKey {
  return (PROJECT_CONFIG_ALLOWED_TOP_LEVEL_KEYS as readonly string[]).includes(key);
}

export function isProjectConfigPluginKeyAllowed(
  key: string,
): key is ProjectConfigAllowedPluginKey {
  return (PROJECT_CONFIG_ALLOWED_PLUGIN_KEYS as readonly string[]).includes(key);
}
