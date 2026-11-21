import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { McpServerConfig, RuntimeConfigPatch } from "@nibi/contracts";
import { PROJECT_CONFIG_ALLOWED_PLUGIN_KEYS } from "@nibi/shared/kernel-contract/project-config";
import {
  createWorkspaceHookSourceInput,
  discoverWorkspaceHookConfigPaths,
  workspaceHooksConfigSchema,
  type WorkspaceHookSourceInput,
} from "@nibi/shared/workspace-hook-discovery";
import { loadFileConfig, type LoadedConfig } from "./file-config.adapter.js";

const CURRENT_DIRECTORY = ".";

export interface ProjectConfigFile {
  baseDir: string;
  config: RuntimeConfigPatch;
  diagnostics: LoadedConfig["diagnostics"];
  hookCandidate?: WorkspaceHookSourceInput;
  loaded: boolean;
  path: string;
}

export interface ProjectConfigDiscovery {
  files: ProjectConfigFile[];
  diagnostics: LoadedConfig["diagnostics"];
  hookCandidates: WorkspaceHookSourceInput[];
  loaded: boolean;
  paths: string[];
  mcpServerNames: string[];
}

export function loadProjectConfigs(
  workingDirectory?: string,
  explicitProjectConfigPath?: string,
): ProjectConfigDiscovery {
  const resolvedWorkingDirectory = resolve(workingDirectory ?? process.cwd());
  const files = discoverWorkspaceHookConfigPaths({
    workingDirectory: resolvedWorkingDirectory,
    ...(explicitProjectConfigPath ? { explicitProjectConfigPath } : {}),
  }).map((ref, discoveryOrder) =>
    loadProjectConfigFile(ref.path, {
      discoveryOrder,
      explicitProjectConfig: ref.explicitProjectConfig,
      workingDirectory: resolvedWorkingDirectory,
      workspaceRoot: resolvedWorkingDirectory,
    }),
  );

  return summarizeProjectConfigs(files);
}

export function loadProjectConfigFile(
  path: string,
  options: {
    discoveryOrder?: number;
    explicitProjectConfig?: boolean;
    workingDirectory?: string;
    workspaceRoot?: string;
  } = {},
): ProjectConfigFile {
  const result = loadFileConfig(path);
  const baseDir = getProjectConfigBaseDir(result.path);
  // 项目内的 plugins.dirs 只允许落在工作区根里。auto discovery 由 loadProjectConfigs 传入
  // workingDirectory；显式 projectConfigPath 没有工作区时以配置文件 baseDir 为根。
  const workspaceRoot =
    options.workspaceRoot ??
    (options.workingDirectory ? resolve(options.workingDirectory) : baseDir);
  const diagnostics = [...result.diagnostics];
  const hooks = result.loaded ? result.config.hooks : undefined;

  if (hooks) {
    diagnostics.push({
      code: "config_project_hooks_pending_trust",
      filePath: result.path,
      message: "Project hooks are pending workspace trust and remain blocked",
      path: "hooks",
      severity: "warning",
    });
  }

  return {
    baseDir,
    config: result.loaded
      ? normalizeProjectConfig(result.config, baseDir, workspaceRoot, result.path, diagnostics)
      : {},
    diagnostics,
    ...(hooks
      ? {
          hookCandidate: createWorkspaceHookSourceInput({
            path: result.path,
            workingDirectory: resolve(options.workingDirectory ?? baseDir),
            // hooks 字段已由 loadFileConfig 经 NibiConfigFileSchema（shared 单源
            // schema）完成运行时校验；这里的 parse 仅做类型桥接——HooksRuntimeConfigPatch
            // 与 WorkspaceHooksConfig 是两个领域类型（执行 side vs 配置 side，字段语义有
            // 微差），不共享 TS 结构。禁止改成 as 断言绕过校验。
            hooks: workspaceHooksConfigSchema.parse(hooks),
            discoveryOrder: options.discoveryOrder ?? 0,
            explicitProjectConfig: options.explicitProjectConfig,
          }),
        }
      : {}),
    loaded: result.loaded,
    path: result.path,
  };
}

export function summarizeProjectConfigs(files: ProjectConfigFile[]): ProjectConfigDiscovery {
  const loadedFiles = files.filter((file) => file.loaded);
  const mcpServerNames = new Set<string>();

  for (const file of loadedFiles) {
    for (const name of Object.keys(file.config.mcp?.servers ?? {})) {
      mcpServerNames.add(name);
    }
  }

  return {
    diagnostics: files.flatMap((file) => file.diagnostics),
    files: loadedFiles,
    hookCandidates: loadedFiles.flatMap((file) => (file.hookCandidate ? [file.hookCandidate] : [])),
    loaded: loadedFiles.length > 0,
    paths: loadedFiles.map((file) => file.path),
    mcpServerNames: [...mcpServerNames],
  };
}

function getProjectConfigBaseDir(path: string): string {
  const configDirectory = dirname(path);
  return basename(configDirectory) === ".nibi" ? dirname(configDirectory) : configDirectory;
}

/**
 * 项目文件只读扩展声明（PROJECT-CONFIG）：顶层只留 `mcp` 与 `plugins` 的白名单子键；`hooks` 只进
 * immutable candidate side-channel，不进入可执行 patch。其余键逐条记诊断后剔除。
 */
function normalizeProjectConfig(
  config: RuntimeConfigPatch,
  baseDir: string,
  workspaceRoot: string,
  filePath: string,
  diagnostics: LoadedConfig["diagnostics"],
): RuntimeConfigPatch {
  const normalized: RuntimeConfigPatch = {};

  for (const [key, value] of Object.entries(config)) {
    // Project Hook declarations are retained only in the immutable candidate side-channel.
    // The executable RuntimeConfigPatch remains hook-free until a later admission phase.
    if (key === "hooks") continue;
    if (key === "mcp") {
      normalized.mcp = value as RuntimeConfigPatch["mcp"];
      continue;
    }
    if (key === "plugins") {
      const plugins = normalizeProjectPlugins(
        value,
        baseDir,
        workspaceRoot,
        filePath,
        diagnostics,
      );
      if (Object.keys(plugins).length > 0) normalized.plugins = plugins;
      continue;
    }
    // 未知键也走这里：allowlist 之外的项目键缺省不开放。
    for (const ignoredPath of ignoredProjectKeyPaths(key, value)) {
      pushIgnoredProjectKeyDiagnostic(diagnostics, filePath, ignoredPath);
    }
  }

  if (!normalized.mcp?.servers) return normalized;

  return {
    ...normalized,
    mcp: {
      ...normalized.mcp,
      servers: Object.fromEntries(
        Object.entries(normalized.mcp.servers).map(([name, server]) => [
          name,
          normalizeProjectMcpServer(server, baseDir),
        ]),
      ),
    },
  };
}

/**
 * `plugins` 段只认 `dirs`、`enabledPlugins` 与 `options`。
 * - `dirs`：解析后必须在工作区根之内，越界项丢弃并记 `plugins.dirs[i]`。
 * - `enabledPlugins`：项目层写 `true` 等于让仓库给已安装插件放权，丢弃并记诊断；`false`（禁用）保留。
 * - `options`：声明式配置，值已由 schema 的 `pluginOptionValueSchema` 校验，运行时按插件
 *   manifest 的 `userConfig` schema 消费。
 */
function normalizeProjectPlugins(
  value: unknown,
  baseDir: string,
  workspaceRoot: string,
  filePath: string,
  diagnostics: LoadedConfig["diagnostics"],
): NonNullable<RuntimeConfigPatch["plugins"]> {
  if (!isPlainObject(value)) {
    pushIgnoredProjectKeyDiagnostic(diagnostics, filePath, "plugins");
    return {};
  }

  const plugins: NonNullable<RuntimeConfigPatch["plugins"]> = {};
  for (const [key, pluginValue] of Object.entries(value)) {
    if (key === "dirs") {
      const dirs = normalizeProjectPluginDirs(
        pluginValue,
        baseDir,
        workspaceRoot,
        filePath,
        diagnostics,
      );
      if (dirs !== undefined) plugins.dirs = dirs;
      continue;
    }
    if (key === "enabledPlugins") {
      const enabledPlugins = normalizeProjectEnabledPlugins(pluginValue, filePath, diagnostics);
      if (enabledPlugins !== undefined) plugins.enabledPlugins = enabledPlugins;
      continue;
    }
    if (key === "options") {
      plugins.options = pluginValue as NonNullable<RuntimeConfigPatch["plugins"]>["options"];
      continue;
    }
    if (!(PROJECT_CONFIG_ALLOWED_PLUGIN_KEYS as readonly string[]).includes(key)) {
      pushIgnoredProjectKeyDiagnostic(diagnostics, filePath, `plugins.${key}`);
    }
  }
  return plugins;
}

/**
 * 项目内的插件目录：相对路径按项目配置 baseDir 解析，绝对路径规范化；只有等于或位于
 * `workspaceRoot` 之下才保留。越界项（home、其他盘、`..` 逃逸）逐项丢弃并记精确下标。
 *
 * 存在时再取 realpath：仓库里放一个指向工作区外的符号链接可以绕过纯词法的前缀检查。
 * 目录不存在时无法加载插件，词法检查足够；存在时把解析后的真实路径交给插件发现。
 */
function normalizeProjectPluginDirs(
  value: unknown,
  baseDir: string,
  workspaceRoot: string,
  filePath: string,
  diagnostics: LoadedConfig["diagnostics"],
): string[] | undefined {
  if (!Array.isArray(value)) {
    pushIgnoredProjectKeyDiagnostic(diagnostics, filePath, "plugins.dirs");
    return undefined;
  }

  const canonicalWorkspaceRoot = canonicalizeExistingPath(workspaceRoot);
  const dirs: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string" || item.length === 0) {
      // schema 已拒绝非字符串/空串；这里仍按未知项丢弃，避免带进插件发现。
      pushIgnoredProjectKeyDiagnostic(diagnostics, filePath, `plugins.dirs[${index}]`);
      return;
    }
    const resolved = isAbsolute(item) ? resolve(item) : resolve(baseDir, item);
    // Windows 的 8.3 短名（RUNNER~1）会让“存在的工作区根”与“尚不存在的子目录”出现
    // 两种写法；先做词法归属判断，再把相对段拼到真实根上，最后用真实路径复核越界。
    const lexicalRelative = relative(workspaceRoot, resolved);
    const lexicallyInside =
      lexicalRelative === "" ||
      (lexicalRelative !== ".." &&
        !lexicalRelative.startsWith(`..${sep}`) &&
        !isAbsolute(lexicalRelative));
    if (lexicallyInside) {
      const canonical = canonicalizeExistingPath(
        lexicalRelative === ""
          ? canonicalWorkspaceRoot
          : join(canonicalWorkspaceRoot, lexicalRelative),
      );
      if (isPathWithin(canonical, canonicalWorkspaceRoot)) {
        dirs.push(canonical);
        return;
      }
    }
    pushIgnoredProjectKeyDiagnostic(diagnostics, filePath, `plugins.dirs[${index}]`);
  });
  return dirs;
}

/** 路径存在时取 realpath（解开符号链接）；不存在或读取失败时退回词法路径。 */
function canonicalizeExistingPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function isPathWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalizeProjectEnabledPlugins(
  value: unknown,
  filePath: string,
  diagnostics: LoadedConfig["diagnostics"],
): Record<string, boolean> | undefined {
  if (!isPlainObject(value)) {
    pushIgnoredProjectKeyDiagnostic(diagnostics, filePath, "plugins.enabledPlugins");
    return undefined;
  }

  const enabledPlugins: Record<string, boolean> = {};
  for (const [pluginId, enabled] of Object.entries(value)) {
    if (enabled === false) {
      enabledPlugins[pluginId] = false;
    } else if (enabled === true) {
      pushIgnoredProjectKeyDiagnostic(
        diagnostics,
        filePath,
        `plugins.enabledPlugins.${pluginId}`,
      );
    } else {
      // schema 已拒绝非布尔值；这里仍按未知项丢弃，避免宽松解析把坏值带进合并。
      pushIgnoredProjectKeyDiagnostic(
        diagnostics,
        filePath,
        `plugins.enabledPlugins.${pluginId}`,
      );
    }
  }
  return enabledPlugins;
}

/**
 * 被剔除的键路径：对象递归到叶子（`permission.mode`、`storage.dir`），数组与标量算一个键；
 * 空对象记它自己。
 */
function ignoredProjectKeyPaths(key: string, value: unknown): string[] {
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length > 0) {
      return entries.flatMap(([child, childValue]) =>
        ignoredProjectKeyPaths(`${key}.${child}`, childValue),
      );
    }
  }
  return [key];
}

function pushIgnoredProjectKeyDiagnostic(
  diagnostics: LoadedConfig["diagnostics"],
  filePath: string,
  keyPath: string,
): void {
  diagnostics.push({
    code: "config_project_key_ignored",
    filePath,
    message: `Project config key "${keyPath}" is ignored; project files only declare hooks, MCP servers and plugin switches`,
    path: keyPath,
    severity: "warning",
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeProjectMcpServer(server: McpServerConfig, baseDir: string): McpServerConfig {
  if (server.type !== "stdio") return server;

  const cwd = server.cwd ?? CURRENT_DIRECTORY;
  return {
    ...server,
    cwd: isAbsolute(cwd) ? cwd : resolve(baseDir, cwd),
  };
}
