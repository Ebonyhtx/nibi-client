import { isAbsolute, posix, relative } from "node:path";

import { resolveWorkspacePath } from "../tool/path-policy.js";

/**
 * 根与目标都是 POSIX 形状时按 POSIX 求相对路径（win32 的 relative 会把两者当成
 * 当前盘上的路径，给出错误结果甚至带反斜杠的绝对路径）。
 */
function relativeLikeRoot(rootDir: string, filePath: string): string {
  const posixLike = (value: string) =>
    value.startsWith("/") && !/^[A-Za-z]:/u.test(value) && !value.includes("\\");
  return posixLike(rootDir) && posixLike(filePath)
    ? posix.relative(rootDir, filePath)
    : relative(rootDir, filePath);
}

const SENSITIVE_MEMORY_PATH_SEGMENTS = new Set([
  ".git",
  "hooks",
  ".husky",
  ".githooks",
  "node_modules",
  ".vscode",
  ".idea",
  "head",
  "config",
  "objects",
  "refs",
  ".claude",
  ".nibi",
  "skills",
  "commands",
  "agents",
  ".cargo",
  ".devcontainer",
  ".yarn",
  ".mvn",
]);

export function resolveContainedMemoryFilePath(input: {
  filePath: string;
  rootDir: string;
  workingDirectory: string;
  workspaceRoot: string;
}): string | undefined {
  const resolvedPath = resolveWorkspacePath({
    inputPath: input.filePath,
    operation: "write",
    workingDirectory: input.workingDirectory,
    workspaceRoot: input.workspaceRoot,
  });
  const relativePath = relativeLikeRoot(input.rootDir, resolvedPath);
  return isContainedRelativePath(relativePath) ? resolvedPath : undefined;
}

export function resolveSafeMemoryFilePath(input: {
  filePath: string;
  rootDir: string;
  workingDirectory: string;
  workspaceRoot: string;
}): string | undefined {
  const resolvedPath = resolveContainedMemoryFilePath(input);
  if (!resolvedPath) return undefined;
  const relativePath = memoryFileRelativePath(input.rootDir, resolvedPath);
  return relativePath && !containsSensitiveMemoryPathSegment(relativePath)
    ? resolvedPath
    : undefined;
}

export function memoryFileRelativePath(rootDir: string, filePath: string): string | undefined {
  const relativePath = relativeLikeRoot(rootDir, filePath);
  return isContainedRelativePath(relativePath) ? relativePath : undefined;
}

export function containsSensitiveMemoryPathSegment(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]+/u)
    .some((segment) => SENSITIVE_MEMORY_PATH_SEGMENTS.has(normalizeSensitiveSegment(segment)));
}

function isContainedRelativePath(relativePath: string): boolean {
  return (
    relativePath.length > 0 &&
    relativePath !== ".." &&
    !relativePath.startsWith("../") &&
    !relativePath.startsWith("..\\") &&
    !isAbsolute(relativePath)
  );
}

function normalizeSensitiveSegment(segment: string): string {
  const withoutControls = segment
    .toLowerCase()
    .replace(/[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu, "");
  return (withoutControls.split(":", 1)[0] ?? "").replace(/[. ]+$/u, "");
}
