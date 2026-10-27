import { realpathSync } from "node:fs";
import { platform as currentPlatform } from "node:process";
import type { ExecutionResult } from "@nibi/contracts";
import {
  getToolPathApi,
  normalizeToolPathForComparison,
  type ToolPathApi,
  type ToolPathPlatform,
} from "../path-normalization.js";
import type { ToolRuntimeScope } from "../types.js";

export interface BashCwdPolicyInput {
  resolvedCwd: string | undefined;
  status: ExecutionResult["status"];
  exitCode: number | undefined;
  platform?: ToolPathPlatform;
  workspaceRoot: string;
  runtimeScope?: ToolRuntimeScope;
}

export interface BashCwdPolicyDecision {
  nextWorkingDirectory?: string;
  stderrSuffix?: string;
}

interface NormalizedCwdBoundary {
  pathApi: ToolPathApi;
  resolvedCwd: string;
  workspaceRoot: string;
  equivalentPairs: Array<{ resolvedCwd: string; workspaceRoot: string }>;
}

export function decideBashCwdPolicy(input: BashCwdPolicyInput): BashCwdPolicyDecision {
  if (input.status !== "completed") return {};
  if (input.exitCode !== 0) return {};
  if (!input.resolvedCwd) return {};
  if ((input.runtimeScope ?? "main") !== "main") return {};

  const boundary = normalizeCwdBoundaryInput(input);

  if (isResolvedCwdInsideWorkspace(boundary)) {
    return { nextWorkingDirectory: boundary.resolvedCwd };
  }

  return {
    nextWorkingDirectory: boundary.workspaceRoot,
    stderrSuffix: `Shell cwd was reset to ${boundary.workspaceRoot}`,
  };
}

export function appendBashCwdStderrSuffix(stderr: string, suffix: string | undefined): string {
  if (!suffix) return stderr;
  const stderrWithoutTrailingNewlines = stderr.replace(/[\r\n]+$/, "");
  if (!stderrWithoutTrailingNewlines) return suffix;
  return `${stderrWithoutTrailingNewlines}\n${suffix}`;
}

function normalizeCwdBoundaryInput(input: BashCwdPolicyInput): NormalizedCwdBoundary {
  // 未显式声明平台时按路径形状决定：两边都是 POSIX 形状（远程/WSL/POSIX 方言）就不能
  // 用宿主 win32 规则归一化，否则 cwd 会被改写成反斜杠形式并持久化到后续请求。
  const posixLike = (value: string) =>
    value.startsWith("/") && !/^[A-Za-z]:/u.test(value) && !value.includes("\\");
  const platform =
    input.platform ??
    (posixLike(input.resolvedCwd ?? "") && posixLike(input.workspaceRoot)
      ? ("linux" as const)
      : currentPlatform);
  const pathApi = getToolPathApi(platform);
  const isWindows = platform === "win32";
  const resolvedCwd = normalizeCwdBoundary(input.resolvedCwd ?? "", isWindows);
  const workspaceRoot = normalizeCwdBoundary(input.workspaceRoot, isWindows);
  const equivalentPairs = [{ resolvedCwd, workspaceRoot }];
  // cwd 捕获使用 pwd -P/realpath 得到物理路径；session root 可能是 symlink。
  // 统一收集等价边界后再判断，避免把项目内物理路径误判成离开项目。
  const realResolvedCwd = realpathCwdBoundary(input.resolvedCwd ?? "", isWindows);
  const realWorkspaceRoot = realpathCwdBoundary(input.workspaceRoot, isWindows);

  if (realResolvedCwd && realWorkspaceRoot) {
    equivalentPairs.push({
      resolvedCwd: realResolvedCwd,
      workspaceRoot: realWorkspaceRoot,
    });
  }

  return {
    pathApi,
    resolvedCwd,
    workspaceRoot,
    equivalentPairs,
  };
}

function isResolvedCwdInsideWorkspace(boundary: NormalizedCwdBoundary): boolean {
  return boundary.equivalentPairs.some(({ resolvedCwd, workspaceRoot }) =>
    isInsideOrSamePath(resolvedCwd, workspaceRoot, boundary.pathApi),
  );
}

function isInsideOrSamePath(child: string, parent: string, pathApi: ToolPathApi): boolean {
  const relativePath = pathApi.relative(parent, child);
  return relativePath === "" || !isPathOutsideParent(relativePath, pathApi);
}

function isPathOutsideParent(relativePath: string, pathApi: ToolPathApi): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relativePath)
  );
}

function normalizeCwdBoundary(value: string, isWindows: boolean): string {
  let normalized = normalizeToolPathForComparison(value, isWindows ? "win32" : "linux");
  if (!isWindows) {
    normalized = normalized
      .replace(/^\/private\/var\//, "/var/")
      .replace(/^\/private\/tmp(\/|$)/, "/tmp$1");
  }
  return normalized;
}

function realpathCwdBoundary(value: string, isWindows: boolean): string | undefined {
  try {
    return normalizeCwdBoundary(realpathSync.native(value), isWindows);
  } catch {
    return undefined;
  }
}
