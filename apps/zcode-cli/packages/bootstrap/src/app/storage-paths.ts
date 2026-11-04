// 插件管理在 Host 进程复用时只依赖这两个路径推导，不能把 @nibi/core（整个 agent 运行时）
// 拖进 Host bundle。行为与 paths.ts 的同名函数保持一致；paths.ts 另有 memory 等 core 依赖，
// 仍留给 bootstrap 自身使用。
import { basename, join, posix } from "node:path";

function joinPathLikeRoot(root: string, ...segments: string[]): string {
  const posixRoot = root.startsWith("/") && !/^[A-Za-z]:/u.test(root) && !root.includes("\\");
  return posixRoot ? posix.join(root, ...segments) : join(root, ...segments);
}

export function getCliStorageRoot(storageRoot: string): string {
  return basename(storageRoot) === "cli" ? storageRoot : joinPathLikeRoot(storageRoot, "cli");
}

export function getPluginStorageRoot(cliStorageRoot: string): string {
  return joinPathLikeRoot(cliStorageRoot, "plugins");
}
