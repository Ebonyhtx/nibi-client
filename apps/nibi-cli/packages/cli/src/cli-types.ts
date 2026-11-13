import type {
  TuiReadClipboardImage,
  TuiReadClipboardText,
  TuiWriteClipboardText,
} from "@nibi/tui";
import type { UiLocale } from "@nibi/i18n";
import type { Logger } from "@nibi/contracts";
import type {
  createManagedCdpBrowserRuntime,
  ManagedCdpBrowserRuntimeOptions,
} from "@nibi/adapters/browser";
import type {
  createDefaultProviderEndpointRoutingPort,
  createModelAdapter,
  createNibiApp,
  CreateDefaultProviderEndpointRoutingPortOptions,
  CreateModelAdapterOptions,
  inspectNibiSkill,
  inspectWorkspaceHookTrust,
  grantWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
  inspectNibiCustomCommand,
  InspectNibiCustomCommandOptions,
  InspectNibiSkillOptions,
  listNibiCustomCommands,
  ListNibiCustomCommandsOptions,
  loadNibiCustomCommand,
  listNibiSessions,
  listNibiSkills,
  ListNibiSessionsOptions,
  ListNibiSkillsOptions,
  loginNibiAccount,
  logoutNibiAccount,
  NibiLoginOptions,
  NibiLoginResult,
  NibiLogoutResult,
  resolveLatestSession,
  ResolveLatestSessionOptions,
  RunNibiProtocolAgentOptions,
  prepareNibiTelemetryEnv,
  startProcessProviderRegistryRuntime,
  shutdownNibiTelemetry,
  NibiAppOptions,
} from "@nibi/bootstrap";
import type { CliEnv, DotenvLoadResult, LoadCliDotenvOptions } from "./env.js";
import type { PluginsCommandOverrides } from "./plugins-command.js";
import type { CliShutdownProcess } from "./shutdown.js";
import type { resolveWorkspaceGitBranch } from "./tui-workspace-git.js";

export type BootstrapModule = typeof import("@nibi/bootstrap");

export interface RunDependencies extends PluginsCommandOverrides {
  migrateStorage?: () => Promise<import("@nibi/shared/sqlite-migrations").MigrationResult>;
  protocolLifecycle?: RunNibiProtocolAgentOptions["lifecycle"];
  protocolInput?: NodeJS.ReadableStream;
  createManagedCdpBrowserRuntime?: (
    options?: ManagedCdpBrowserRuntimeOptions,
  ) => ReturnType<typeof createManagedCdpBrowserRuntime>;
  createModelAdapter?: (
    options?: CreateModelAdapterOptions,
  ) => ReturnType<typeof createModelAdapter>;
  createProviderEndpointRoutingPort?: (
    options: CreateDefaultProviderEndpointRoutingPortOptions,
  ) => ReturnType<typeof createDefaultProviderEndpointRoutingPort>;
  createNibiApp?: (
    options?: NibiAppOptions,
  ) => Awaited<ReturnType<typeof createNibiApp>> | ReturnType<typeof createNibiApp>;
  /**
   * Session-event shaper for --output-format stream-json. Defaults to the
   * bootstrap module's, which is also what the protocol server uses; injectable
   * so a caller that supplies its own `createNibiApp` (tests, embedders) can
   * still stream, since the bootstrap module is not loaded on that path.
   */
  mapSessionEvent?: BootstrapModule["mapSessionEvent"];
  cwd?: () => string;
  env?: CliEnv;
  inspectSkill?: (options: InspectNibiSkillOptions) => ReturnType<typeof inspectNibiSkill>;
  inspectWorkspaceHookTrust?: typeof inspectWorkspaceHookTrust;
  grantWorkspaceHookTrust?: typeof grantWorkspaceHookTrust;
  revokeWorkspaceHookTrustCli?: typeof revokeWorkspaceHookTrustCli;
  inspectCustomCommand?: (
    options: InspectNibiCustomCommandOptions,
  ) => ReturnType<typeof inspectNibiCustomCommand>;
  loginNibiAccount?: (options?: NibiLoginOptions) => Promise<NibiLoginResult>;
  logoutNibiAccount?: (options?: {
    env?: CliEnv;
  }) => Promise<NibiLogoutResult>;
  loadDotenv?: (options?: LoadCliDotenvOptions) => DotenvLoadResult;
  prepareNibiTelemetryEnv?: typeof prepareNibiTelemetryEnv;
  projectConfigPath?: string;
  listSessions?: (options: ListNibiSessionsOptions) => ReturnType<typeof listNibiSessions>;
  listCustomCommands?: (
    options: ListNibiCustomCommandsOptions,
  ) => ReturnType<typeof listNibiCustomCommands>;
  loadCustomCommand?: (
    options: InspectNibiCustomCommandOptions,
  ) => ReturnType<typeof loadNibiCustomCommand>;
  // headless slash 路由要和 app facade 的保留名 gate 用同一个判据；默认取 bootstrap 的，
  // 注入点只为让单测不必拉起整个 bootstrap 模块。见 prompt-command.ts。
  isReservedSlashCommandName?: BootstrapModule["isReservedNibiSlashCommandName"];
  listSkills?: (options: ListNibiSkillsOptions) => ReturnType<typeof listNibiSkills>;
  logger?: Logger;
  readClipboardImage?: TuiReadClipboardImage;
  readClipboardText?: TuiReadClipboardText;
  writeClipboardText?: TuiWriteClipboardText;
  resolveLatestSession?: (
    options: ResolveLatestSessionOptions,
  ) => ReturnType<typeof resolveLatestSession>;
  resolveWorkspaceGitBranch?: typeof resolveWorkspaceGitBranch;
  runNibiProtocolAgent?: (options?: RunNibiProtocolAgentOptions) => Promise<void>;
  runTui?: typeof import("@nibi/tui").runTui;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  exitProcess?: (code: number) => void;
  shutdownCleanupTimeoutMs?: number;
  shutdownProcess?: CliShutdownProcess;
  startProcessProviderRegistryRuntime?: typeof startProcessProviderRegistryRuntime;
  shutdownNibiTelemetry?: typeof shutdownNibiTelemetry;
}

export type CliPermissionMode = "build" | "plan" | "edit" | "yolo" | "guarded";
export type CliRuntimeMode = CliPermissionMode | "auto";

export interface CliModeState {
  current?: CliRuntimeMode;
  override?: CliPermissionMode;
}

export interface CliTargetRequest {
  objective: string;
  replaceExisting: boolean;
}

export type ModeCapableApp = Awaited<ReturnType<typeof createNibiApp>> & {
  getMode?: () => CliRuntimeMode;
  setLocale?: (locale: UiLocale) => Promise<{ locale: "en-US" | "zh-CN" }>;
  setMode?: (mode: CliRuntimeMode) => Promise<{ mode: CliRuntimeMode }>;
};

export interface CliResumeRequest {
  continueSession: boolean;
  resumeSessionId?: string;
}
