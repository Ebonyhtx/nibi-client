import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const HOME_PREFIX = "~/";

export interface SubagentStorageOptions {
  homeDir?: string;
  /**
   * 数据根（显式传入优先）。
   *
   * 为什么要有这一项：`resolveZCodeStorageRoot` 原先只认「用户 CLI 配置里的 storage.dir → 默认
   * ~/.zcode」，**完全不看数据根环境变量**。于是数据根不是家目录时会静默读错实例：dev 实例
   * （数据根 = 工作区下的 .nibi-desktop-dev）读到的是**正式实例**的配置与插件记录 ——
   * 表现为"插件装了、技能与命令都生效、子智能体却一个都不出现"，同时还是隔离泄漏。
   * 桌面/宿主进程知道自己用的是哪个数据根，应当直接传进来，而不是让服务从家目录再猜一次。
   */
  storageRoot?: string;
}

export function resolveUserHomeDir(options?: SubagentStorageOptions): string {
  if (options?.homeDir && options.homeDir.trim().length > 0) {
    return options.homeDir;
  }
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

export async function resolveUserSubagentRoot(options?: SubagentStorageOptions): Promise<string> {
  return join(await resolveZCodeStorageRoot(options), "agents");
}

export function resolveWorkspaceSubagentRoot(workspacePath: string): string {
  return join(workspacePath, ".nibi", "agents");
}

export async function resolveSubagentStateFile(options?: SubagentStorageOptions): Promise<string> {
  return join(await resolveZCodeStorageRoot(options), "v2", "agents-state.json");
}

export async function resolveZCodeStorageRoot(options?: SubagentStorageOptions): Promise<string> {
  // 1) 显式传入的数据根（桌面/宿主知道自己的根，传进来最可靠）
  const explicitRoot = options?.storageRoot?.trim();
  if (explicitRoot) return resolveConfigPath(explicitRoot, options);
  // 2) 数据根环境变量（dev 实例与"换数据根"的部署都靠这几个变量隔离；此前这里完全不看它们，
  //    导致非家目录数据根一律读错实例）
  const envRoot =
    process.env.NIBI_STORAGE_DIR?.trim() ||
    process.env.NIBI_DATA_BASE_DIR?.trim() ||
    process.env.NIBI_HOME?.trim();
  if (envRoot) return resolveConfigPath(envRoot, options);
  // 3) 用户 CLI 配置里的 storage.dir
  const config = await readUserCliConfig(options);
  const storage = isObjectRecord(config.storage) ? config.storage : {};
  const storageDir =
    typeof storage.dir === "string" && storage.dir.trim().length > 0
      ? storage.dir.trim()
      : "~/.nibi";
  return resolveConfigPath(storageDir, options);
}

export function resolveConfigPath(path: string, options?: SubagentStorageOptions): string {
  const expanded = path.startsWith(HOME_PREFIX)
    ? join(resolveUserHomeDir(options), path.slice(HOME_PREFIX.length))
    : path;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

async function readUserCliConfig(
  options?: SubagentStorageOptions,
): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(
      join(resolveUserHomeDir(options), ".nibi", "cli", "config.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as unknown;
    return isObjectRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
