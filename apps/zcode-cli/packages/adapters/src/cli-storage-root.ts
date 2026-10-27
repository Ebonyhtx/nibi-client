import { homedir } from "node:os";
import { join } from "node:path";

/**
 * CLI 的存储根：`NIBI_STORAGE_DIR` 覆盖默认的 `~/.nibi`。
 *
 * 会话、rollout、插件、记忆、日志、用户配置都按 `<storageRoot>/cli/...` 布局
 * （与 execution-utils / clipboard-image / sea-runtime-tools 是同一约定）。凡是
 * **派生**自该根的默认路径都必须经这里解析：写死 `homedir()` 会让隔离运行
 * （TUI 调试、`zcode-beta` 通道、任何显式指定存储根的部署）去读写真实用户的
 * `~/.nibi/cli/...`。
 *
 * 实测事故：TUI 的界面语言写进了桌面端正在用的 `~/.nibi/cli/config.json`，
 * 并连带加载桌面端启用的插件 —— 存储根设了，派生路径却各写各的。
 *
 * 与 `NIBI_DATA_BASE_DIR` 的分工：那个管 `<root>/.nibi/v2/...`（provider 配置、
 * settings、任务索引），这个管 `<root>/cli/...`。两者是独立的根，都要设。
 */
export function resolveCliStorageRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.NIBI_STORAGE_DIR?.trim() || join(homedir(), ".nibi");
}

/** 用户级 CLI 目录 `<storageRoot>/cli`，即默认的 `~/.nibi/cli` 在隔离下的位置。 */
export function resolveCliRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveCliStorageRoot(env), "cli");
}
