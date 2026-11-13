import {
  traceContextToLogContext,
  type FileSystemPort,
  type Logger,
  type TraceContext,
} from "@nibi/contracts";
import { join, posix } from "node:path";

/**
 * 根是 POSIX 形状（`/home/...`、`/storage/...`）时按 POSIX 语义拼路径。
 *
 * 记忆/计划这类根的“形状”由来源决定（WSL、远程工作区、显式注入的测试根），不一定与
 * 宿主一致；win32 的 join 会把 `/storage/x` 拼成 `\storage\x`，随后按字符串索引的
 * 端口（读写状态、fixture）就对不上了。
 */
export function joinPathLikeRoot(root: string, ...segments: string[]): string {
  const posixRoot = root.startsWith("/") && !/^[A-Za-z]:/u.test(root) && !root.includes("\\");
  return posixRoot ? posix.join(root, ...segments) : join(root, ...segments);
}

export async function ensureMemoryDirectoryExists(
  fileSystemPort: FileSystemPort,
  rootDir: string,
  traceContext?: TraceContext,
  logger?: Logger,
): Promise<void> {
  try {
    await fileSystemPort.createDirectory({ path: rootDir, trace: traceContext });
  } catch (error) {
    // 目录预创建失败不阻断执行；实际 Write/Edit 仍返回原始文件错误。
    logger?.debug("Memory directory creation failed", {
      ...(traceContext ? traceContextToLogContext(traceContext) : {}),
      error: error instanceof Error ? error.message : String(error),
      event: "memory.directory.create_failed",
      module: "core.memory",
      status: "failed",
    });
  }
}
