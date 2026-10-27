// ============================================================
// Tool Path Normalization Helpers
// ============================================================

import path, { posix } from "node:path";
import { platform as currentPlatform } from "node:process";

export type ToolPathPlatform = NodeJS.Platform;
export type ToolPathApi = typeof path.posix | typeof path.win32;

export function getToolPathApi(platform: ToolPathPlatform): ToolPathApi {
  return platform === "win32" ? path.win32 : path.posix;
}

export function normalizeToolPathForComparison(
  filePath: string,
  platform: ToolPathPlatform = currentPlatform,
): string {
  // 平台参数必须真正决定归一化规则：win32 走 Windows 归一化，其余走 POSIX。
  // 此前非 win32 分支直接用宿主 `normalize`，在 Windows 宿主上把显式声明的
  // "linux"/"darwin" 输入也按反斜杠归一化，与同模块 getToolPathApi(platform)
  // 返回的 posix api 自相矛盾（边界用宿主分隔符、比较用 POSIX api）。
  const normalized =
    platform === "win32" ? normalizeWindowsToolPath(filePath) : posix.normalize(filePath);
  return normalized.normalize("NFC");
}

function normalizeWindowsToolPath(filePath: string): string {
  const driveAliasNormalized = normalizeWindowsDriveAlias(filePath);
  const prefixStripped = stripWindowsExtendedPathPrefix(path.win32.normalize(driveAliasNormalized));
  return canonicalizeWindowsDriveLetter(prefixStripped);
}

function normalizeWindowsDriveAlias(filePath: string): string {
  // Read/Edit/Write 和 Bash cwd 都会收到 Git Bash 风格的 /c/... 路径；
  // 统一转换到 drive-letter 形式，避免各工具重复实现 Windows path 兼容逻辑。
  const driveAliasMatch = filePath.match(/^\/([A-Za-z])\//);
  if (!driveAliasMatch) return filePath;

  const drive = driveAliasMatch[1]!.toUpperCase();
  const rest = filePath.slice(2);
  return `${drive}:${rest}`.replaceAll("/", "\\");
}

function canonicalizeWindowsDriveLetter(filePath: string): string {
  return filePath.replace(/^([a-zA-Z]):/, (_, drive: string) => `${drive.toUpperCase()}:`);
}

function stripWindowsExtendedPathPrefix(filePath: string): string {
  // 只剥离 extended UNC 和 drive path，保留 Volume/GLOBALROOT 等设备命名空间。
  if (filePath.startsWith("\\\\?\\UNC\\")) return `\\\\${filePath.slice("\\\\?\\UNC\\".length)}`;
  if (filePath.startsWith("\\\\?\\") && filePath.length >= 7 && filePath[5] === ":") {
    return filePath.slice("\\\\?\\".length);
  }
  return filePath;
}
