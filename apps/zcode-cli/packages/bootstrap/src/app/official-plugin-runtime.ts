import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  NIBI_OFFICIAL_PLUGIN_MARKETPLACE,
  NIBI_PLUGIN_HOST_COMMAND,
  type McpServerConfig,
} from "@nibi/contracts";
import { NIBI_PLUGIN_ID_ENV_KEY, PLUGIN_MANIFEST_DIRS } from "@nibi/shared";
import {
  createOfficialPluginCacheRetryBudget,
  type OfficialPluginCacheRetryBudget,
  writeTextFileAtomicallyWithRetry,
} from "./official-plugin-cache-fs.js";

type SeaModule = typeof import("node:sea");

const MCP_SERVER_RELATIVE_PATH = ["dist", "mcp", "server.js"] as const;

export function createBundledMcpRuntimeConfig(input: {
  cwd: string;
  env?: Record<string, string>;
  relativeServerPath?: readonly string[];
  rootPath: string;
  timeoutMs?: number;
}): McpServerConfig | undefined {
  const hostPrefixArgs = officialPluginHostPrefixArgs();
  if (!hostPrefixArgs) return undefined;
  return {
    args: [
      ...hostPrefixArgs,
      join(input.rootPath, ...(input.relativeServerPath ?? MCP_SERVER_RELATIVE_PATH)),
    ],
    command: process.execPath,
    cwd: input.cwd,
    env: {
      ...input.env,
      // 桌面打包态 process.execPath 是 ZCode Helper；缺少 Node 模式会误进 Electron main。
      ELECTRON_RUN_AS_NODE: "1",
    },
    timeoutMs: input.timeoutMs,
    type: "stdio",
  };
}

interface OfficialRuntimeManifestInput {
  sourceManifestContents?: string;
  pluginName: string;
  retryBudget?: OfficialPluginCacheRetryBudget;
  rootPath: string;
}

export function writeOfficialPluginRuntimeManifest(input: OfficialRuntimeManifestInput): void {
  // 内置件已迁到 .nibi-plugin；写死 .zcode-plugin 会让新格式的插件整段跳过重写，
  // MCP server 于是以 `command: "node"`（且没有 ELECTRON_RUN_AS_NODE）进入缓存，
  // 桌面应用里会被当成 Electron main 启动。按发现优先级取第一个存在的清单目录。
  const manifestDir =
    PLUGIN_MANIFEST_DIRS.find((dir) => existsSync(join(input.rootPath, dir, "plugin.json"))) ??
    PLUGIN_MANIFEST_DIRS[0];
  const manifestPath = join(input.rootPath, manifestDir, "plugin.json");
  const currentContents = readFileSync(manifestPath, "utf8");
  // 缓存里的入口可能已被旧客户端覆盖，必须从内置原始 manifest 重新生成。
  const manifest = JSON.parse(input.sourceManifestContents ?? currentContents) as Record<
    string,
    unknown
  >;
  const hostPrefixArgs = officialPluginHostPrefixArgs();
  if (!hostPrefixArgs) return;

  // 同一批内置件有的把 MCP 声明在 plugin.json，有的放在 Claude 兼容的 `.mcp.json`
  // （ios-simulator / android-emulator 就是后者）。只重写 plugin.json 会让这些 server
  // 以 `command: "node"`、没有 ELECTRON_RUN_AS_NODE 的形态进入缓存。
  rewritePluginMcpConfigFile(input.rootPath, hostPrefixArgs, input.retryBudget);

  // skill-only / command-only 类型的 official plugin 不带 mcpServers：不阻断，
  // 上面已经把 `.mcp.json` 处理完（之前这里直接 return 会跳过整段）。
  if (manifest.mcpServers === undefined) return;
  const mcpServers = asRecord(manifest.mcpServers);

  // 保留对其他历史 official plugin MCP 的通用重写；zcode-cua 当前是 skill/SDK-only，
  // 不会进入这个分支，也不会生成独立的 CUA MCP server。
  for (const [serverKey, serverRaw] of Object.entries(mcpServers)) {
    const mcpServer = asRecord(serverRaw);
    // HTTP/SSE 插件没有本地入口；按 stdio 校验会让 image-search 阻断整个会话初始化。
    if (mcpServer.type !== undefined && mcpServer.type !== "stdio") continue;
    const mcpServerEnv = isRecord(mcpServer.env) ? mcpServer.env : {};
    const serverArgs =
      input.sourceManifestContents === undefined
        ? [join(input.rootPath, ...MCP_SERVER_RELATIVE_PATH)]
        : mcpServer.args;
    if (
      !Array.isArray(serverArgs) ||
      !serverArgs.every((arg): arg is string => typeof arg === "string") ||
      serverArgs.length === 0
    ) {
      throw new Error("Official plugin manifest has invalid MCP server args.");
    }
    mcpServer.command = process.execPath;
    // 文档插件使用 dist/server.mjs；统一覆盖成 dist/mcp/server.js 会导致启动失败。
    mcpServer.args = [
      ...hostPrefixArgs,
      // 清单里写的是 `${NIBI_PLUGIN_ROOT}/dist/...`；直接替换会得到 `C:\root/dist/...`
      // 这种混合分隔符（Windows 上某些启动器会当成两段路径）。绝对路径统一按宿主归一化。
      ...serverArgs.map((arg) => normalizeServerArgArg(arg, input.rootPath)),
    ];
    mcpServer.env = {
      ...mcpServerEnv,
      // 桌面打包态的 process.execPath 是 ZCode Helper。
      // 官方插件 MCP server 缺少 Node 模式 env 时会误进 Electron main，触发 deep-link 注册等桌面副作用。
      ELECTRON_RUN_AS_NODE: "1",
      // 权威写入插件身份（pluginName@marketplace，来自本地 plugin registry，manifest/user env 不可覆盖）。
      // 其他 official plugin 仍带上不可伪造的 plugin identity；CUA broker 凭据由 shared
      // node_repl 的可信配置注入，不再写入独立 server。
      [NIBI_PLUGIN_ID_ENV_KEY]: `${input.pluginName}@${NIBI_OFFICIAL_PLUGIN_MARKETPLACE}`,
    };
    mcpServers[serverKey] = mcpServer;
  }
  manifest.mcpServers = mcpServers;

  const nextContents = `${JSON.stringify(manifest, null, 2)}\n`;
  // 启动时无条件 rename 同内容的 plugin.json 会放大 Windows 杀毒/索引器
  // 的短暂文件占用。字节完全一致时不触碰文件；真正有更新时仍保持原子的失败语义。
  if (nextContents === currentContents) return;
  writeTextFileAtomicallyWithRetry(
    manifestPath,
    nextContents,
    input.retryBudget ?? createOfficialPluginCacheRetryBudget(),
  );
}

/**
 * 重写插件根目录下的 `.mcp.json`（Claude 插件生态的 MCP 声明文件）。
 *
 * 与 plugin.json 的规则一致：command 换成宿主可执行文件、参数前面补插件宿主入口、
 * 注入 ELECTRON_RUN_AS_NODE。已经重写过的条目跳过（幂等），否则每次启动都会把宿主前缀
 * 再叠一层。
 */
function rewritePluginMcpConfigFile(
  rootPath: string,
  hostPrefixArgs: string[],
  retryBudget: OfficialPluginCacheRetryBudget | undefined,
): void {
  const filePath = join(rootPath, ".mcp.json");
  if (!existsSync(filePath)) return;
  const currentContents = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(currentContents) as Record<string, unknown>;
  const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
  if (!servers) return;

  let changed = false;
  for (const [serverKey, serverRaw] of Object.entries(servers)) {
    const server = asRecord(serverRaw);
    if (server.type !== undefined && server.type !== "stdio") continue;
    if (server.command === process.execPath) continue;
    const args = Array.isArray(server.args)
      ? server.args.map((arg) =>
          typeof arg === "string"
            ? normalizeSeededPath(arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", rootPath))
            : arg,
        )
      : [];
    server.command = process.execPath;
    server.args = [...hostPrefixArgs, ...args];
    server.env = {
      ...(isRecord(server.env) ? server.env : {}),
      ELECTRON_RUN_AS_NODE: "1",
    };
    servers[serverKey] = server;
    changed = true;
  }
  if (!changed) return;

  const nextContents = `${JSON.stringify(parsed, null, 2)}\n`;
  if (nextContents === currentContents) return;
  writeTextFileAtomicallyWithRetry(
    filePath,
    nextContents,
    retryBudget ?? createOfficialPluginCacheRetryBudget(),
  );
}

export function officialPluginHostPrefixArgs(): string[] | undefined {
  if (isSeaRuntime()) return [NIBI_PLUGIN_HOST_COMMAND];

  const entrypoint = process.argv[1];
  if (!entrypoint) return undefined;

  return [...process.execArgv, resolve(entrypoint), NIBI_PLUGIN_HOST_COMMAND];
}

function isSeaRuntime(): boolean {
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea").isSea() === true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (isRecord(value)) {
    return value as Record<string, unknown>;
  }
  throw new Error("Official plugin manifest has invalid mcpServers.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeServerArgArg(arg: string, rootPath: string): string {
  const replaced = arg.replaceAll("${NIBI_PLUGIN_ROOT}", rootPath);
  return replaced === arg ? arg : normalizeSeededPath(replaced);
}

function normalizeSeededPath(value: string): string {
  return value.includes("/") && /^[A-Za-z]:/.test(value) ? value.replaceAll("/", "\\") : value;
}
