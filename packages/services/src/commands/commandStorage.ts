/**
 * 用户命令目录与启用覆盖的公共读写。
 *
 * 命令服务（commandsService）与命令数据同步（data-sync/commandDataSync）共用这一份口径：
 * 命令根优先级、`config.json` 里 `command[<绝对文件路径>].enable` 的读取与写入只在这里维护。
 * 数据同步从这里导入而不是从 commandsService 导入，避免
 * commandsService → commandDataSync → commandsService 的循环依赖。
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { updateJsonObjectFile } from "#src/fs/atomicFileUtils.js";
import { resolveNibiStorageRoot } from "#src/subagents/subagentStorage.js";

const ENABLE_OVERRIDE_KEY = "enable";

/** 用户级命令目录来源：`.nibi` 为强优先级，`.agents` 为兼容来源。 */
export type UserCommandRootSource = "nibi" | "agents";

const USER_COMMAND_ROOT_SEGMENTS: Record<UserCommandRootSource, readonly string[]> = {
  nibi: [".nibi", "commands"],
  agents: [".agents", "commands"],
};

/** 用户级命令目录的路径片段（相对用户主目录），workspace 命令目录也复用同一组片段。 */
export function getUserCommandRootSegments(source: UserCommandRootSource): readonly string[] {
  return USER_COMMAND_ROOT_SEGMENTS[source];
}

export function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

/** 用户级命令根：默认 `.nibi`，传 `agents` 得到兼容目录。 */
export function getUserCommandsRoot(source: UserCommandRootSource = "nibi"): string {
  return join(resolveUserHomeDir(), ...USER_COMMAND_ROOT_SEGMENTS[source]);
}

/**
 * CLI 配置路径（`<数据根>/cli/config.json`）。必须跟数据根走：`config.json` 记的是"这个实例
 * 装了哪些插件/命令"，写死用户主目录会让隔离实例（桌面端 dev / e2e）去读写**另一个实例**的配置
 * —— 同一类缺陷在 skillsService / subagents 都实测过，口径见
 * `subagents/subagentStorage.ts#resolveNibiStorageRoot`。
 */
export async function getUserCliConfigPath(): Promise<string> {
  return join(await resolveNibiStorageRoot(), "cli", "config.json");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 只用于列表展示：config.json 损坏时按空配置展示命令，不影响浏览。写入一律走 updateUserCliConfig。
export async function readUserCliConfig(): Promise<Record<string, unknown>> {
  try {
    const content = await readFile(await getUserCliConfigPath(), "utf-8");
    const parsed = JSON.parse(content) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 根因：旧实现写入前用 readUserCliConfig 读取，读失败或 JSON 损坏时返回空对象，再用 writeFile
 * 整文件写回，config.json 里的 MCP、插件等其他配置会被冲掉；writeFile 也不是原子写。
 * 修法：写入路径改用 updateJsonObjectFile——文件损坏时报错不写，写前重读，只改 command 字段，原子替换。
 */
export async function updateUserCliConfig(
  update: (config: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  await updateJsonObjectFile(await getUserCliConfigPath(), update);
}

export function readCommandEnabledOverrides(
  config: Record<string, unknown>,
): Map<string, boolean> {
  const commandConfig = config.command;
  const overrides = new Map<string, boolean>();
  if (!isRecord(commandConfig)) {
    return overrides;
  }

  for (const [filePath, entry] of Object.entries(commandConfig)) {
    if (isRecord(entry) && typeof entry[ENABLE_OVERRIDE_KEY] === "boolean") {
      overrides.set(filePath, entry[ENABLE_OVERRIDE_KEY]);
    }
  }
  return overrides;
}

export async function readCommandEnabledOverridesFromUserConfig(): Promise<Map<string, boolean>> {
  return readCommandEnabledOverrides(await readUserCliConfig());
}

export function getCommandEnabled(
  filePath: string,
  overrides: ReadonlyMap<string, boolean>,
): boolean {
  return overrides.get(filePath) ?? true;
}

export function setCommandEnabledOverride(
  config: Record<string, unknown>,
  filePath: string,
  enabled: boolean,
): Record<string, unknown> {
  const commandConfig = isRecord(config.command) ? { ...config.command } : {};

  if (enabled) {
    delete commandConfig[filePath];
  } else {
    commandConfig[filePath] = { [ENABLE_OVERRIDE_KEY]: false };
  }

  const nextConfig: Record<string, unknown> = { ...config };
  if (Object.keys(commandConfig).length > 0) {
    nextConfig.command = commandConfig;
  } else {
    delete nextConfig.command;
  }
  return nextConfig;
}

export interface CommandEnabledOverrideEntry {
  filePath: string;
  enabled: boolean;
}

/**
 * 批量写入命令启用覆盖（一次读改写，避免多条命令各写一遍 config.json）。
 * config.json 损坏时 `updateJsonObjectFile` 会抛错且不写，由调用方决定回滚。
 */
export async function setUserCommandEnabledOverrides(
  entries: readonly CommandEnabledOverrideEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  await updateUserCliConfig((config) =>
    entries.reduce(
      (next, entry) => setCommandEnabledOverride(next, entry.filePath, entry.enabled),
      config,
    ),
  );
}
