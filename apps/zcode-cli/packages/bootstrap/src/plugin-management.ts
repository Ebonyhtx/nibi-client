// Host 进程可导入的插件管理边界。
//
// 这不是第二套实现：Host 与 CLI/agent 共用 `nibi-protocol/plugins.ts` 的同一批处理器，
// 只是把上下文收窄成 `PluginManagementContext`（logger + env）。会话权威的
// `plugins/referenceCatalog`（带 sessionId）不在导出面内，仍必须由持有 session 的
// 内核/agent 回答；Host 只做转发。
//
// 插件运行时（MCP/hooks/skills/commands/UI）不在这里，也不因管理面下沉而改变。
export {
  addPluginMarketplace,
  configurePlugin,
  describePlugin,
  getPluginsOverview,
  installPlugin,
  listPlugins,
  removePluginMarketplace,
  resetPluginConfig,
  restoreBuiltinPlugin,
  setPluginEnabled,
  toPluginInfo,
  uninstallPlugin,
  updatePlugin,
  updatePluginMarketplace,
  validatePlugin,
  type PluginManagementContext,
} from "./nibi-protocol/plugins.js";
export { listPluginUiSurfaces } from "./nibi-protocol/plugin-ui-surfaces.js";
