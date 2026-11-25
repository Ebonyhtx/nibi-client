import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * 插件包内容 hash。
 *
 * 设计目标：同一份内容在任何机器、任何遍历顺序下得到同一个 hash；mtime 不参与，
 * 增删改文件一定改变 hash。用途是把用户同意绑定到「这段代码」而不是「这个版本号」：
 * 同版本号换了内容就不能拿旧同意继续跑（见 `03-NIBI-PLUGIN-PLAN.md` §7.5）。
 */
export const PLUGIN_PACKAGE_HASH_PREFIX = "sha256:";

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/** 超过文件数或字节上限时抛出；绝不返回「部分内容」的 hash。 */
export class PluginPackageHashError extends Error {
  readonly code: "too_large";

  constructor(message: string) {
    super(message);
    this.name = "PluginPackageHashError";
    this.code = "too_large";
  }
}

export interface ComputePluginPackageHashOptions {
  /** 参与 hash 的条目上限（常规文件 + 符号链接），默认 20000。 */
  maxFiles?: number;
  /** 参与 hash 的内容字节上限，默认 512MB。 */
  maxBytes?: number;
}

/** 只跳过明确的噪音目录；其余目录一律参与 hash，避免把内容变化漏掉。 */
const SKIPPED_FILE_NAMES = new Set([".ds_store", "thumbs.db", ".git"]);

interface CollectedEntry {
  absolutePath: string;
  kind: "file" | "symlink";
  linkTarget?: string;
  /** POSIX 风格相对路径，同时作为排序键。 */
  relativePath: string;
  size: number;
}

/**
 * 计算插件根目录的确定性内容 hash，返回 `sha256:<64hex>`。
 *
 * 规则：
 * - 递归遍历，按 POSIX 相对路径的代码单元序排序后逐条喂给外层 sha256；
 * - 常规文件喂 `相对路径\0大小\0内容sha256`；
 * - 符号链接只按链接目标字符串计入，不跟随（避免链接环与外部内容影响）；
 * - 跳过 `.git`、`node_modules/.cache`、`.DS_Store`、`Thumbs.db`、`*.tmp`；
 * - 超过 `maxFiles` / `maxBytes` 抛 {@link PluginPackageHashError}（code `too_large`）。
 */
export function computePluginPackageHash(
  rootPath: string,
  options: ComputePluginPackageHashOptions = {},
): string {
  const maxFiles = normalizeLimit(options.maxFiles, DEFAULT_MAX_FILES);
  const maxBytes = normalizeLimit(options.maxBytes, DEFAULT_MAX_BYTES);
  const entries = collectEntries(rootPath, maxFiles, maxBytes);
  // 排序必须稳定且与语言环境无关：直接比较 JS 字符串的代码单元，不用 localeCompare。
  entries.sort((left, right) => {
    if (left.relativePath < right.relativePath) return -1;
    if (left.relativePath > right.relativePath) return 1;
    return 0;
  });
  const outer = createHash("sha256");
  for (const entry of entries) {
    if (entry.kind === "symlink") {
      // 链接目标字符串原样计入；加类型标记避免与同名常规文件的内容混淆。
      outer.update(`${entry.relativePath}\0symlink\0${entry.linkTarget ?? ""}`);
      continue;
    }
    const contentHash = createHash("sha256")
      .update(readFileSync(entry.absolutePath))
      .digest("hex");
    outer.update(`${entry.relativePath}\0${entry.size}\0${contentHash}`);
  }
  return `${PLUGIN_PACKAGE_HASH_PREFIX}${outer.digest("hex")}`;
}

/**
 * 校验 hash 是否为本模块产出的规范格式。
 * 同意文件读取与 backfill 都走这里，避免写入无法校验的脏值。
 */
export function isPluginPackageHash(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function collectEntries(
  rootPath: string,
  maxFiles: number,
  maxBytes: number,
): CollectedEntry[] {
  const entries: CollectedEntry[] = [];
  let totalBytes = 0;

  const addEntry = (entry: CollectedEntry): void => {
    entries.push(entry);
    totalBytes += entry.size;
    if (entries.length > maxFiles) {
      throw new PluginPackageHashError(
        `Plugin package exceeds maxFiles limit (${maxFiles}); hash not computed`,
      );
    }
    if (totalBytes > maxBytes) {
      throw new PluginPackageHashError(
        `Plugin package exceeds maxBytes limit (${maxBytes}); hash not computed`,
      );
    }
  };

  const visit = (directoryPath: string, directoryRelativePath: string): void => {
    const names = readdirSync(directoryPath).sort();
    for (const name of names) {
      const absolutePath = join(directoryPath, name);
      const relativePath = directoryRelativePath
        ? `${directoryRelativePath}/${name}`
        : name;
      const stat = lstatSync(absolutePath);
      if (stat.isDirectory()) {
        if (isSkippedDirectory(relativePath)) continue;
        visit(absolutePath, relativePath);
        continue;
      }
      if (stat.isSymbolicLink()) {
        const linkTarget = readlinkSync(absolutePath);
        addEntry({
          absolutePath,
          kind: "symlink",
          linkTarget,
          relativePath,
          size: Buffer.byteLength(linkTarget, "utf8"),
        });
        continue;
      }
      if (!stat.isFile()) continue;
      if (isSkippedFile(name)) continue;
      addEntry({
        absolutePath,
        kind: "file",
        relativePath,
        size: stat.size,
      });
    }
  };

  visit(rootPath, "");
  return entries;
}

function isSkippedDirectory(relativePath: string): boolean {
  // relativePath 全部由本模块用 "/" 拼出，跨平台一致。
  const segments = relativePath.toLowerCase().split("/");
  if (segments.includes(".git")) return true;
  // 只跳过 node_modules 下的缓存目录，不动 node_modules 本身。
  for (let index = 0; index + 1 < segments.length; index += 1) {
    if (segments[index] === "node_modules" && segments[index + 1] === ".cache") return true;
  }
  return false;
}

function isSkippedFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SKIPPED_FILE_NAMES.has(lower) || lower.endsWith(".tmp");
}
