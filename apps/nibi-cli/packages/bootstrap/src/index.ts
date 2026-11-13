// Bootstrap public API surface.

export * from "./app/create-app.js";
export type {
  ListNibiSessionsOptions,
  PromptInput,
  ResolveLatestSessionOptions,
  ResumeOptions,
  RunNibiProtocolAgentOptions,
  SendInputOptions,
  SendInputResult,
  SetLocaleResult,
  SteerTurnOptions,
  SubmitPromptOptions,
  UserPromptInput,
  NibiApp,
  NibiAppOptions,
  NibiModelOption,
} from "./app/types.js";
export * from "./auth-login.js";
export * from "./auth-nibi-login.js";
export {
  listNibiProviderTemplates,
  renameNibiProvider,
  setupNibiCustomProvider,
  setupNibiProvider,
} from "./provider-setup.js";
export type {
  NibiCustomProviderApiType,
  NibiCustomProviderSetupOptions,
  NibiProviderRenameResult,
  NibiProviderSetupResult,
  NibiProviderTemplateSummary,
} from "./provider-setup.js";

export {
  inspectNibiCustomCommand,
  listNibiCustomCommands,
  loadNibiCustomCommand,
} from "./custom-commands.js";
export type {
  InspectNibiCustomCommandOptions,
  ListNibiCustomCommandsOptions,
  NibiCustomCommandInspection,
} from "./custom-commands.js";
export { createModelAdapter } from "./model-factory.js";
export type { CreateModelAdapterOptions } from "./model-factory.js";
export {
  createDefaultProviderEndpointRoutingPort,
  resolveProcessProviderEndpointRoutingPort,
} from "./provider-endpoint-routing.js";
export type {
  CreateDefaultProviderEndpointRoutingPortOptions,
  ResolveProcessProviderEndpointRoutingPortOptions,
} from "./provider-endpoint-routing.js";
export { startProcessProviderRegistryRuntime } from "./app/process-provider-registry-runtime.js";
export type { ProcessProviderRegistryRuntimeOptions } from "./app/process-provider-registry-runtime.js";
export {
  addNibiPluginMarketplace,
  getNibiPluginsOverview,
  installNibiMarketplacePlugin,
  listNibiPlugins,
  removeNibiPluginMarketplace,
  resolveNibiPlugins,
  setNibiPluginEnabled,
  uninstallNibiMarketplacePlugin,
  updateNibiMarketplacePlugin,
  updateNibiPluginMarketplace,
  validateNibiPluginPath,
} from "./plugins.js";
export type {
  AddNibiMarketplaceOptions,
  InstallNibiMarketplacePluginOptions,
  ListNibiPluginsOptions,
  RemoveNibiMarketplaceOptions,
  ResolveNibiPluginsOptions,
  SetNibiPluginEnabledOptions,
  SetNibiPluginEnabledResult,
  UninstallNibiMarketplacePluginOptions,
  UpdateNibiMarketplaceOptions,
  UpdateNibiMarketplacePluginOptions,
  ValidateNibiPluginPathOptions,
  NibiAvailablePluginData,
  NibiInstalledPluginData,
  NibiMarketplaceSummaryData,
  NibiMarketplaceUpdateData,
  NibiPluginInstallData,
  NibiPluginUpdateData,
  NibiPluginsOverviewData,
} from "./plugins.js";
export { runNibiProtocolAgent } from "./nibi-protocol-entrypoint.js";
// Exposed for the CLI's --output-format stream-json: it needs the same event
// shape the protocol server emits, rather than inventing a second one.
export { mapSessionEvent } from "./nibi-protocol/session-mapper.js";
export { prepareNibiTelemetryEnv, shutdownNibiTelemetry } from "./telemetry-bootstrap.js";
export type { SessionTranscriptMessage, SessionTranscriptPart } from "./session-transcript.js";
export { listNibiSessions, resolveLatestSession } from "./sessions.js";
export { inspectNibiSkill, listNibiSkills } from "./skills.js";
export type {
  InspectNibiSkillOptions,
  ListNibiSkillsOptions,
  NibiSkillInspection,
} from "./skills.js";
// Exposed for the CLI's headless slash routing: it must decide "is this a real
// custom command?" with the *same* reserved-name gate the app facade's
// customCommandPromptResolver applies, or the two disagree and a reserved name
// reaches the model as literal prompt text. See prompt-command.ts.
export { isReservedNibiSlashCommandName } from "./slash-command-surface.js";
// DWF 导入缓存的构建面（路线 C 的 sidecar 复用同一份纯函数——「两侧必须是同一张表」的
// 正确性前提就是字面上跑同一段代码；见 app/dynamic-workflow-import.ts 文件头）。
export {
  buildImportedCache,
  rebuildImportedCacheForResume,
} from "./app/dynamic-workflow-import.js";
export type { AmendImportOptions } from "./app/dynamic-workflow-import.js";
export type { ImportedRunCache } from "@nibi/dynamic-workflow";
// EvalWorkflowSnippet 的执行面（sidecar 复用生产同一条编译/沙箱/world-read 路径）。
export { createDynamicWorkflowSnippetService } from "./app/dynamic-workflow-snippet-service.js";
export {
  grantWorkspaceHookTrust,
  inspectWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
} from "./workspace-hook-trust-cli.js";
export type {
  WorkspaceHookTrustCliItem,
  WorkspaceHookTrustCliStatus,
  WorkspaceHookTrustCliTarget,
} from "./workspace-hook-trust-cli.js";
