// worktree 显示名 `<仓库名> · <bucket>`，只由任务的 worktree 根目录推导：
// 受管布局为 <受管根>/<bucket>/<仓库名>。
import type { useNibiIntl } from "@/i18n/IntlProvider.js";

type NibiIntl = ReturnType<typeof useNibiIntl>["intl"];

export function formatWorktreeLabel(intl: NibiIntl, worktreeRoot: string | undefined): string | null {
  if (!worktreeRoot) return null;
  // Windows 路径与 POSIX 路径都按两种分隔符切分；结尾分隔符不影响结果。
  const segments = worktreeRoot.split(/[\\/]+/).filter(Boolean);
  const name = segments.at(-1);
  const bucket = segments.at(-2);
  return name && bucket
    ? intl.formatMessage({ id: "git.managedWorktree.name" }, { repo: name, bucket })
    : null;
}

/**
 * 从任务 cwd 识别受管 worktree 根：布局固定为 `.../.nibi/worktrees/<4位hex>/<仓库名>`。
 * 只做路径识别，不判断目录是否存在；可用性仍由 Host 的 isWorktreeAvailable 裁决。
 */
export function managedWorktreeRootFromPath(path: string | undefined): string | null {
  if (!path) return null;
  const match = /^(.*[\\/])\.nibi[\\/]worktrees[\\/]([0-9a-f]{4})[\\/]([^\\/]+)(?:[\\/].*)?$/i.exec(
    path,
  );
  if (!match) return null;
  const [, prefix, bucket, name] = match;
  if (!prefix || !bucket || !name) return null;
  const separator = prefix.includes("\\") ? "\\" : "/";
  return `${prefix}.nibi${separator}worktrees${separator}${bucket}${separator}${name}`;
}