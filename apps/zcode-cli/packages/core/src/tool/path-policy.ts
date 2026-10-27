// ============================================================
// Tool Path Policy
// ============================================================

import { isAbsolute, normalize, posix, resolve } from "node:path";
import { CoreErrorType, createCoreError } from "@nibi/contracts";

/**
 * POSIX 绝对路径（`/storage/x`）在 win32 上 isAbsolute() 也为 true（当前盘根），
 * 但 normalize()/resolve() 会把它改成 `\storage\x`。工作区可能是 POSIX 形状
 * （WSL、远程工作区、端口 stub），这时必须按 POSIX 语义处理：
 * 否则路径会变形，按字符串索引的读写状态、记忆记录与权限规则都会对不上。
 */
function isPosixAbsolutePath(value: string): boolean {
  return value.startsWith("/") && !/^[A-Za-z]:/u.test(value) && !value.includes("\\");
}

interface ToolWorkspacePathOptions {
  inputPath: string;
  workingDirectory: string;
  workspaceRoot: string;
  operation: "read" | "write" | "execute";
}

export function resolveWorkspacePath(options: ToolWorkspacePathOptions): string {
  const workingDirectory = normalizeAbsoluteDirectory(
    options.workingDirectory,
    "workingDirectory",
  );
  normalizeAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
  const requestedPath = options.inputPath;

  if (requestedPath.length === 0) {
    throw createCoreError(CoreErrorType.ToolExecutionFailed, "Tool path must not be empty", {
      context: {
        operation: options.operation,
      },
      recoverable: true,
    });
  }

  const resolvedPath = isPosixAbsolutePath(requestedPath)
    ? posix.normalize(requestedPath)
    : isAbsolute(requestedPath)
      ? normalize(requestedPath)
      : isPosixAbsolutePath(workingDirectory)
        ? posix.resolve(workingDirectory, requestedPath)
        : resolve(workingDirectory, requestedPath);

  // Current release intentionally does not hard-block paths outside workspaceRoot.
  // Cause: subagents may need to inspect user-requested sibling repos or external files
  // before the filesystem permission adapter grows explicit ask/deny rules for them.
  return resolvedPath;
}

export function resolveToolWorkingDirectory(
  inputCwd: string | undefined,
  options: Omit<ToolWorkspacePathOptions, "inputPath">,
): string {
  if (!inputCwd) {
    const workingDirectory = normalizeAbsoluteDirectory(
      options.workingDirectory,
      "workingDirectory",
    );
    normalizeAbsoluteDirectory(options.workspaceRoot, "workspaceRoot");
    return workingDirectory;
  }

  return resolveWorkspacePath({
    ...options,
    inputPath: inputCwd,
  });
}

function normalizeAbsoluteDirectory(value: string, label: string): string {
  if (isPosixAbsolutePath(value)) {
    return posix.normalize(value);
  }
  const normalized = normalize(value);
  if (!isAbsolute(normalized)) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      `${label} must be an absolute path for tool execution`,
      {
        context: {
          [label]: value,
        },
        recoverable: false,
      },
    );
  }
  return normalized;
}
