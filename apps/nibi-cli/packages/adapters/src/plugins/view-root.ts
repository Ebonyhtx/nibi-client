import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sanitizePluginId } from "./helpers.js";

/**
 * 插件 view root 物化（计划 B §6.5）。
 *
 * 外部插件目录对 Host 是只读输入：插件可能是 git 工作区、下载缓存或用户手工维护的目录。
 * Host 为每个插件生成一份自己的视图 `~/.nibi/plugins/views/<pluginId>/`，运行时只读这份视图。
 *
 * ## 为什么不是「挑几个组件目录复制」
 *
 * 第一版只复制了 `manifest.json` / `skills` / `commands` / `agents` / `hooks.json`。
 * 一旦让运行时改读视图根，插件就会**静默丢功能**：`mcp.json` 不见了、清单里自定义的
 * `skills: "./custom/x"` 不见了、`runtime.entry` 指的文件不见了。Node 适配器与 Rust `ext`
 * 都是直接扫插件目录的，所以视图根必须**逐条等价**，不能只覆盖常见布局。
 *
 * ## 为什么不是「符号链接」
 *
 * 组件扫描器出于信任边界**刻意不跟随链接**（`scanSkillFilesUnderRootSync` 的
 * `followSymbolicLinks: false`）。把 `skills/` 做成 junction/符号链接后，扫描器看到的是
 * 一个空目录——技能、命令、agent 会全部消失。链接方案在这里不可用。
 *
 * ## 采用的形态：真实目录 + 硬链接文件
 *
 * 视图根用**真实目录**复刻源目录结构，文件用硬链接（同一 inode，零额外磁盘，
 * 内容与源目录天然一致）。这样：
 * 1. 扫描器看到普通目录/普通文件，行为与读源目录完全一致；
 * 2. 不占双份磁盘（硬链接不复制数据）；
 * 3. 不可能陈旧——读到的就是源文件本体。
 *
 * 硬链接失败（跨卷、文件系统不支持）时退回复制；复制模式下必须通过**相对文件集合**
 * 等价性校验才允许使用，校验不过就报错，而不是降级成「少几个文件」。
 *
 * 规范清单写在根 `plugin.json`：Node 与 Rust 的清单候选列表都以根 `plugin.json` 优先，
 * 因此两边读取结果一致，且 Rust 对已摊平清单再摊平一次是无害的（没有 extensions 时原样返回）。
 *
 * 幂等判据：规范清单字节相同即视为当前（其中含来源、版本、`packageHash`；没有 hash 的
 * 来源还含源目录 stamp）。有 hash 时判断是 O(1)，启动路径可以放心反复调用。
 */

export const PLUGIN_VIEWS_DIR = "views";

/** 视图根里的规范化清单文件名：必须是读取方第一个候选。 */
const VIEW_MANIFEST_FILE = "plugin.json";
/** 视图自身的实现元数据（模式/来源）。读取方不认识它，也不参与等价性校验。 */
const VIEW_META_FILE = ".nibi-view.json";
/** 源目录里不进入视图的噪音：版本库元数据对运行时没有意义。 */
const SKIPPED_SOURCE_ENTRIES = new Set([".git"]);
/**
 * 原子替换留下的临时目录名：`<name>.tmp-<pid>-<uuid>` / `<name>.old-<pid>-<uuid>`。
 * 列举视图根时必须排除，否则崩溃残留会被当成一个插件目录暴露给 UI。
 */
const TRANSIENT_VIEW_ROOT_PATTERN =
  /\.(?:tmp|old)-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 视图根改名备份/暂存的临时后缀（与上面的模式对应）。 */
const TRANSIENT_SUFFIX_PATTERN = /\.(?:tmp|old)-\d+-[0-9a-f-]{36}$/i;

type ViewRootMode = "mirror" | "copy";

interface ViewRootStamp {
  bytes: number;
  files: number;
  maxMtimeMs: number;
}

interface ViewRootMeta {
  mode: ViewRootMode;
  sourceRoot: string;
}

export interface MaterializePluginViewRootInput {
  storageRoot: string;
  pluginId: string;
  /** 插件源根目录（只读输入，不会被改写）。 */
  rootPath: string;
  /** 已归一化的清单（NIBI 扩展已摊平）。 */
  manifest: Record<string, unknown>;
  /**
   * 源清单相对插件根的 POSIX 路径（`plugin.json` / `.claude-plugin/plugin.json` …）。
   *
   * 必须排除它：视图根写的是规范化后的根 `plugin.json`，如果再把原清单复刻进来，
   * 会出现两个身份来源；对 `.claude-plugin/plugin.json` 这种嵌套位置还会让读取方
   * 看到「根清单 + 旧目录清单」并存的矛盾状态。
   */
  manifestRelativePath?: string;
  origin: string;
  version?: string;
  packageHash?: string;
}

export interface PluginViewRootResult {
  mode: ViewRootMode;
  viewRoot: string;
  wrote: boolean;
}

/**
 * 视图根路径。
 *
 * `sanitizePluginId` 会保留 `.` 与 `@`：`@` 是 marketplace 限定名的常规字符；
 * 但 `.` / `..` / 空串仍是可拼出父目录或 views 自身的危险输入，必须单独兜底，
 * 保证任何 pluginId 都无法把视图根写到 views 目录之外。
 */
export function getPluginViewRoot(storageRoot: string, pluginId: string): string {
  const sanitized = sanitizePluginId(pluginId);
  if (sanitized === "" || sanitized === "." || sanitized === "..") {
    const digest = createHash("sha256").update(pluginId).digest("hex").slice(0, 16);
    return join(storageRoot, PLUGIN_VIEWS_DIR, `plugin-${digest}`);
  }
  return join(storageRoot, PLUGIN_VIEWS_DIR, sanitized);
}

/**
 * 列举已物化的视图根目录名（排序）。
 *
 * 只返回目录：views 下可能有临时文件或崩溃残留，目录名集合才是 Host 可消费的插件视图。
 */
export function listPluginViewRoots(storageRoot: string): string[] {
  const viewsRoot = join(storageRoot, PLUGIN_VIEWS_DIR);
  try {
    return readdirSync(viewsRoot, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && !TRANSIENT_VIEW_ROOT_PATTERN.test(entry.name),
      )
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // 从未物化过任何插件时 views 目录不存在，这是正常状态而不是错误。
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
}

/**
 * 删除视图根，返回是否真的删掉了东西。
 *
 * 视图根里是硬链接与真实目录：删除只移除链接本身，不会动到源文件数据。
 * 仍然逐条 `lstat`（而不是 `rm -rf`），因为源插件可能自带符号链接，
 * 递归删除跟进去就会删到插件根之外。
 */
export function removePluginViewRoot(storageRoot: string, pluginId: string): boolean {
  const viewRoot = getPluginViewRoot(storageRoot, pluginId);
  if (!pathExistsSync(viewRoot)) return false;
  removeViewTree(viewRoot);
  return true;
}

/**
 * 判断现有视图根是否与给定输入等价。
 *
 * 判据是规范清单字节完全相同（含来源、版本、`packageHash`；没有 hash 的来源还含源目录
 * stamp）。有 hash 时是 O(1) 读取，因此启动路径可以放心反复调用。
 */
export function isPluginViewRootCurrentSync(
  storageRoot: string,
  input: MaterializePluginViewRootInput,
): boolean {
  const viewRoot = getPluginViewRoot(storageRoot, input.pluginId);
  if (!isRealDirectorySync(viewRoot)) return false;
  let stored: Buffer;
  try {
    stored = readFileSync(join(viewRoot, VIEW_MANIFEST_FILE));
  } catch {
    return false;
  }
  if (!stored.equals(buildViewRootManifestBytes(input))) return false;
  // 顶层条目集合也要比：源目录新增/删除一个顶层目录（例如后来加的 `agents/`）时，
  // 只比清单字节会漏判，视图就会缺一整类组件。这只是一次 readdir，代价可忽略。
  const expected = new Set(skippedTopLevelEntries(input));
  expected.add(VIEW_META_FILE);
  const sourceNames = listDirectoryNames(input.rootPath).filter((name) => !expected.has(name));
  // 视图里的 `plugin.json` 是 Host 写的规范清单，源目录没有对应条目，比较时要排除。
  const viewNames = listDirectoryNames(viewRoot).filter(
    (name) => name !== VIEW_META_FILE && name !== VIEW_MANIFEST_FILE,
  );
  return sameStringSets(sourceNames, viewNames);
}

function listDirectoryNames(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => !TRANSIENT_SUFFIX_PATTERN.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * 同步物化视图根。发现层是同步热路径，因此以同步实现为核心、异步版本只是包装。
 *
 * 返回 `null` 表示**无法建立等价视图**（复制校验不通过、权限失败等）。调用方必须
 * 退回读源目录，而不是用一个不完整的视图去糊弄运行时——那会表现为插件功能静默消失。
 */
export function materializePluginViewRootSync(
  input: MaterializePluginViewRootInput,
): PluginViewRootResult | null {
  const viewRoot = getPluginViewRoot(input.storageRoot, input.pluginId);
  const manifestBytes = buildViewRootManifestBytes(input);
  if (isPluginViewRootCurrentSync(input.storageRoot, input)) {
    return { mode: readViewRootMode(viewRoot), viewRoot, wrote: false };
  }

  // mkdir 必须放进 try：views 路径被占用（文件/无权限）时要能回退，
  // 而不是把「视图建不出来」升级成插件发现失败。
  const stagedPath = createStagingPath(viewRoot);
  try {
    mkdirSync(dirname(viewRoot), { recursive: true });
    const mode = writeStagedViewRootSync(stagedPath, input, manifestBytes);
    replaceViewRootSync(stagedPath, viewRoot);
    return { mode, viewRoot, wrote: true };
  } catch {
    removeViewTree(stagedPath);
    return null;
  }
}

/** 异步包装：安装/更新等已是异步的路径用它，避免调用方再包一层 Promise。 */
export async function materializePluginViewRoot(
  input: MaterializePluginViewRootInput,
): Promise<PluginViewRootResult | null> {
  return materializePluginViewRootSync(input);
}

function buildViewRootManifestBytes(input: MaterializePluginViewRootInput): Buffer {
  const viewMeta: Record<string, unknown> = { origin: input.origin };
  // 只写调用方显式给出的版本：清单自身已有 version 字段，这里记录的是「Host 认为自己在看哪一版」，
  // 二者混用会让消费方无法区分来源。
  if (input.version !== undefined) viewMeta.version = input.version;
  if (input.packageHash !== undefined) {
    viewMeta.packageHash = input.packageHash;
  } else {
    // 没有包 hash 的来源（inline/本地目录）只能靠源目录 stamp 判断是否过期。
    // 有 hash 时不写 stamp：否则每次发现都要遍历一遍才能比较，白付启动成本。
    viewMeta.stamp = computeSourceStamp(input.rootPath);
  }
  // `nibiViewRoot` 是 Host 保留的视图元数据，最后写入，防止插件用同名字段伪造来源。
  // 其余字段原样保留：视图清单首先是插件清单，宿主只追加一个命名空间。
  const manifest: Record<string, unknown> = {
    ...input.manifest,
    nibiViewRoot: viewMeta,
  };
  return Buffer.from(`${stableJson(manifest)}\n`, "utf8");
}

function writeStagedViewRootSync(
  stagedPath: string,
  input: MaterializePluginViewRootInput,
  manifestBytes: Buffer,
): ViewRootMode {
  mkdirSync(stagedPath, { recursive: true });
  writeFileSync(join(stagedPath, VIEW_MANIFEST_FILE), manifestBytes);
  const skippedTopLevel = skippedTopLevelEntries(input);
  const stats = mirrorDirectorySync(input.rootPath, stagedPath, skippedTopLevel, true);
  if (stats.copiedFiles > 0) {
    // 有文件退回了复制：必须证明视图与源目录的文件集合完全一致，否则宁可不用视图。
    const expected = listRelativeFiles(input.rootPath, skippedTopLevel, true);
    const actual = listRelativeFiles(stagedPath, new Set([VIEW_META_FILE]), true);
    if (!sameStringSets(actual, expected)) {
      throw new Error("Plugin view root copy is not equivalent to the source directory");
    }
  }
  const mode: ViewRootMode = stats.copiedFiles > 0 ? "copy" : "mirror";
  const meta: ViewRootMeta = { mode, sourceRoot: resolve(input.rootPath) };
  writeFileSync(join(stagedPath, VIEW_META_FILE), `${stableJson(meta)}\n`, "utf8");
  return mode;
}

/**
 * 顶层跳过项：噪音目录 + 源清单。
 *
 * `manifestRelativePath` 可能是嵌套路径（`.claude-plugin/plugin.json`）；嵌套情况整个
 * 目录都不复刻，否则视图里会同时出现根清单与旧目录清单两个身份来源。
 */
function skippedTopLevelEntries(input: MaterializePluginViewRootInput): Set<string> {
  const skipped = new Set(SKIPPED_SOURCE_ENTRIES);
  const relative = input.manifestRelativePath?.replace(/\\/gu, "/");
  if (relative) skipped.add(relative.split("/")[0] ?? relative);
  return skipped;
}

interface MirrorStats {
  copiedFiles: number;
}

/** 复刻目录结构；文件硬链接优先，失败退回复制。链接/特殊文件原样重建。 */
function mirrorDirectorySync(
  source: string,
  destination: string,
  skippedTopLevel: Set<string>,
  isRoot: boolean,
): MirrorStats {
  const stats: MirrorStats = { copiedFiles: 0 };
  let entries: Dirent[];
  try {
    entries = readdirSync(source, { withFileTypes: true });
  } catch {
    return stats;
  }
  for (const entry of entries) {
    if (isRoot && skippedTopLevel.has(entry.name)) continue;
    if (isRoot && TRANSIENT_SUFFIX_PATTERN.test(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      // 源插件自带的链接原样重建；扫描器不跟随链接，所以它不会扩大可见面。
      const target = readLinkTargetSync(from);
      if (target !== null) {
        try {
          symlinkSync(target, to);
        } catch {
          // 无法重建链接时跳过：它本来也不会被扫描器读取。
        }
      }
      continue;
    }
    if (entry.isDirectory()) {
      mkdirSync(to, { recursive: true });
      stats.copiedFiles += mirrorDirectorySync(from, to, skippedTopLevel, false).copiedFiles;
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      linkSync(from, to);
    } catch {
      try {
        copyFileSync(from, to);
        stats.copiedFiles += 1;
      } catch {
        // 复制也失败：交给上层等价性校验兜底（集合不一致 → 整个视图作废）。
      }
    }
  }
  return stats;
}

function computeSourceStamp(source: string): ViewRootStamp {
  const stamp: ViewRootStamp = { bytes: 0, files: 0, maxMtimeMs: 0 };
  const walk = (directory: string, isRoot: boolean): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isRoot && SKIPPED_SOURCE_ENTRIES.has(entry.name)) continue;
      if (isRoot && TRANSIENT_SUFFIX_PATTERN.test(entry.name)) continue;
      const target = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(target, false);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const info = statSync(target);
        stamp.files += 1;
        stamp.bytes += info.size;
        stamp.maxMtimeMs = Math.max(stamp.maxMtimeMs, info.mtimeMs);
      } catch {
        // 竞态删除：不计入。
      }
    }
  };
  walk(source, true);
  return stamp;
}

/** 列出相对文件路径（用于复制模式的等价性校验）；不跟随符号链接。 */
function listRelativeFiles(root: string, skippedTopLevel: Set<string>, isRootOnly: boolean): string[] {
  const files: string[] = [];
  const walk = (directory: string, prefix: string, isRoot: boolean): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (isRoot && skippedTopLevel.has(entry.name)) continue;
      if (isRoot && TRANSIENT_SUFFIX_PATTERN.test(entry.name)) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(directory, entry.name), relativePath, false);
        continue;
      }
      if (entry.isFile()) files.push(relativePath);
    }
  };
  walk(root, "", isRootOnly);
  return files.sort();
}

function readViewRootMode(viewRoot: string): ViewRootMode {
  try {
    const parsed = JSON.parse(readFileSync(join(viewRoot, VIEW_META_FILE), "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { mode?: unknown }).mode === "copy"
    ) {
      return "copy";
    }
  } catch {
    // 缺少元数据（旧视图/被手工删过）：按镜像处理，不影响读取。
  }
  return "mirror";
}

function replaceViewRootSync(stagedPath: string, viewRoot: string): void {
  const backupPath = `${viewRoot}.old-${process.pid}-${randomUUID()}`;
  let movedExisting = false;
  if (pathExistsSync(viewRoot)) {
    // POSIX 与 Windows 都不允许 rename 覆盖非空目标目录，只能先把旧版本挪到备份名；
    // 这样新版本 rename 成功前，旧版本始终是完整可读状态，只是路径暂时换了名字。
    renameSync(viewRoot, backupPath);
    movedExisting = true;
  }
  try {
    renameSync(stagedPath, viewRoot);
  } catch (error) {
    if (movedExisting && !pathExistsSync(viewRoot)) {
      try {
        renameSync(backupPath, viewRoot);
      } catch {
        // 回滚也失败时保留 backup 供恢复；原始错误才是调用方需要看到的失败原因。
      }
    }
    throw error;
  }
  if (movedExisting) removeViewTree(backupPath);
}

/**
 * 删除视图树：只删链接与目录项，绝不跟进去删源目录内容。
 *
 * 这是安全关键路径——视图根里的文件是源文件的硬链接，符号链接可能来自源插件自身。
 */
function removeViewTree(path: string): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    try {
      unlinkSync(path);
    } catch {
      try {
        rmdirSync(path);
      } catch {
        // 已经不存在：目标状态达成。
      }
    }
    return;
  }
  for (const entry of entries) {
    const target = join(path, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        unlinkSync(target);
      } catch {
        // 已被并发清理。
      }
      continue;
    }
    if (entry.isDirectory()) {
      removeViewTree(target);
      continue;
    }
    try {
      unlinkSync(target);
    } catch {
      // 只读文件在部分平台需要先改权限再删。
      try {
        chmodSync(target, 0o644);
        unlinkSync(target);
      } catch {
        // 尽力而为：残留会被下一次原子替换覆盖。
      }
    }
  }
  try {
    rmdirSync(path);
  } catch {
    // 非空/权限：交给上层重试或下次替换。
  }
}

function sameStringSets(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort();
  const rightSorted = [...right].sort();
  return leftSorted.every((value, index) => value === rightSorted[index]);
}

function createStagingPath(viewRoot: string): string {
  // pid 便于定位哪个进程留下的残骸，uuid 防止同一进程并发物化互相覆盖。
  return `${viewRoot}.tmp-${process.pid}-${randomUUID()}`;
}

function pathExistsSync(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function isRealDirectorySync(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readLinkTargetSync(path: string): string | null {
  try {
    // readlink 不跟随，直接给出源目录里那条链接的原始目标。
    return readlinkSync(path);
  } catch {
    return null;
  }
}

/** 递归按 key 排序；undefined 字段直接省略，避免 JSON.stringify 在各平台上产生歧义。 */
function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value)) ?? "null";
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(entries.map(([key, item]) => [key, sortJsonValue(item)]));
}

/** 供发现层诊断：源目录是否可作为插件根。 */
export function isPluginViewSourceDirectory(rootPath: string): boolean {
  try {
    return statSync(rootPath).isDirectory();
  } catch {
    return false;
  }
}

/** 供测试：视图根是否存在。 */
export function pluginViewRootExists(storageRoot: string, pluginId: string): boolean {
  return existsSync(getPluginViewRoot(storageRoot, pluginId));
}
