import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  readdirSync,
  rmSync,
  type Dirent,
} from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { sanitizePluginId } from "./helpers.js";

/**
 * 插件 view root 物化（计划 B §6.5）。
 *
 * 外部插件目录对 Host 是只读输入：插件可能是 git 工作区、下载缓存或用户手工维护的目录，
 * 直接在里面写状态会污染用户数据，也让「这段代码有没有被改过」不可判定。
 * 因此 Host 为每个插件生成一份自己的副本 `~/.nibi/plugins/views/<pluginId>/`，
 * 把清单、技能、命令、agents 和 hooks 收敛到 Host 可控的位置，运行时只读这份副本。
 *
 * 副本可以是指向源码目录的符号链接（省磁盘、跟手改），也可以是实体复制（跨设备稳定）；
 * 两者都以「视图根」为唯一读取入口，调用方不需要感知差异。
 */

export const PLUGIN_VIEWS_DIR = "views";

const VIEW_MANIFEST_FILE = "manifest.json";
const VIEW_HOOKS_FILE = "hooks.json";
const VIEW_COMPONENT_DIRECTORIES = ["skills", "commands", "agents"] as const;
const STANDARD_HOOKS_RELATIVE_PATH = join("hooks", "hooks.json");
/** 复制时跳过的噪音目录：版本库元数据与依赖树不属于插件内容，且可能巨大/含链接环。 */
const SKIPPED_COPY_DIRECTORIES = new Set([".git", "node_modules"]);
/** `getPluginViewRoot` 兜底名：空 id、"." 与 ".." 用内容 hash 生成稳定目录名。 */
const FALLBACK_VIEW_ROOT_PREFIX = "plugin-";
/**
 * 原子替换留下的临时目录名：`<name>.tmp-<pid>-<uuid>` / `<name>.old-<pid>-<uuid>`。
 * 列举视图根时必须排除它们，否则崩溃残留会被当成一个插件目录暴露给 UI。
 */
const TRANSIENT_VIEW_ROOT_PATTERN =
  /\.(?:tmp|old)-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ViewRootMode = "copy" | "symlink";

export interface MaterializePluginViewRootInput {
  storageRoot: string;
  pluginId: string;
  rootPath: string;
  manifest: Record<string, unknown>;
  origin: string;
  version?: string;
  packageHash?: string;
  mode?: "copy" | "symlink";
}

interface ViewRootHooksPlan {
  /** 已存在的 `hooks/hooks.json` 原样复制，保留插件作者写下的格式与顺序。 */
  kind: "file" | "manifest";
  path?: string;
  bytes?: Buffer;
}

interface ViewRootPlan {
  /** 源目录里真实存在的组件目录（顶层符号链接不算，与 copy 的跳过规则一致）。 */
  componentDirectories: string[];
  hooks: ViewRootHooksPlan | null;
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
    return join(storageRoot, PLUGIN_VIEWS_DIR, `${FALLBACK_VIEW_ROOT_PREFIX}${digest}`);
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
 * 物化时会把目录 chmod 成只读；POSIX 上只读目录连自己的子项都不允许 unlink，
 * 所以 rm 失败后先恢复写权限再重试，避免移除功能被只读意图反噬。
 */
export function removePluginViewRoot(storageRoot: string, pluginId: string): boolean {
  const viewRoot = getPluginViewRoot(storageRoot, pluginId);
  try {
    lstatSync(viewRoot);
  } catch {
    return false;
  }
  try {
    rmSync(viewRoot, { force: true, maxRetries: 2, recursive: true, retryDelay: 25 });
  } catch {
    chmodTreeWritableSync(viewRoot);
    rmSync(viewRoot, { force: true, maxRetries: 2, recursive: true, retryDelay: 25 });
  }
  return true;
}

/**
 * 物化插件视图根。
 *
 * 幂等判据：清单字节完全相同且组件条目集合相同就完全不动磁盘（连 mtime 都不变），
 * 让启动/刷新路径可以放心反复调用。
 *
 * 变化时先写临时目录再 rename：直接覆盖会留下「清单已是新的、组件还是旧的」的半成品，
 * 而原子替换保证读取方要么看到完整旧版本、要么看到完整新版本。
 */
export async function materializePluginViewRoot(
  input: MaterializePluginViewRootInput,
): Promise<{ viewRoot: string; wrote: boolean; mode: "copy" | "symlink" }> {
  const viewRoot = getPluginViewRoot(input.storageRoot, input.pluginId);
  const requestedMode: ViewRootMode = input.mode ?? "copy";
  const plan = await buildViewRootPlan(input);
  const manifestBytes = buildViewRootManifestBytes(input);

  if (await isViewRootCurrent(viewRoot, manifestBytes, plan)) {
    return {
      viewRoot,
      wrote: false,
      mode: await detectViewRootMode(viewRoot, plan, requestedMode),
    };
  }

  await mkdir(dirname(viewRoot), { recursive: true });
  let stagedPath = createStagingPath(viewRoot);
  let actualMode: ViewRootMode = requestedMode;
  try {
    if (requestedMode === "symlink") {
      try {
        await writeStagedViewRoot(stagedPath, input, plan, manifestBytes, "symlink");
      } catch {
        // 平台/权限不允许目录链接（EPERM、受限容器等）时自动退回复制。
        // 换一个新的临时目录重来，避免残留的半成品链接混进完整副本。
        await removeTreeBestEffort(stagedPath);
        stagedPath = createStagingPath(viewRoot);
        actualMode = "copy";
        await writeStagedViewRoot(stagedPath, input, plan, manifestBytes, "copy");
      }
    } else {
      await writeStagedViewRoot(stagedPath, input, plan, manifestBytes, "copy");
    }
    await replaceViewRootAtomically(stagedPath, viewRoot);
    // chmod 必须在 rename 之后：临时目录若提前变成 0555，替换失败时连自己的子项都删不掉。
    await chmodTreeReadOnly(viewRoot);
  } catch (error) {
    await removeTreeBestEffort(stagedPath);
    throw error;
  }
  return { viewRoot, wrote: true, mode: actualMode };
}

/** 规范化清单：按 key 排序，保证同一份输入在任何进程/顺序下都产生相同字节。 */
function buildViewRootManifestBytes(input: MaterializePluginViewRootInput): Buffer {
  const viewMeta: Record<string, unknown> = { origin: input.origin };
  // 只写调用方显式给出的版本：清单自身已有 version 字段，这里记录的是「Host 认为自己在看哪一版」，
  // 二者混用会让消费方无法区分来源。
  if (input.version !== undefined) viewMeta.version = input.version;
  if (input.packageHash !== undefined) viewMeta.packageHash = input.packageHash;
  // `nibiViewRoot` 是 Host 保留的视图元数据，最后写入，防止插件用同名字段伪造来源。
  // 其余字段原样保留：视图清单首先是插件清单，宿主只追加一个命名空间。
  const manifest: Record<string, unknown> = {
    ...input.manifest,
    nibiViewRoot: viewMeta,
  };
  return Buffer.from(`${stableJson(manifest)}\n`, "utf8");
}

async function buildViewRootPlan(
  input: MaterializePluginViewRootInput,
): Promise<ViewRootPlan> {
  const componentDirectories: string[] = [];
  for (const directory of VIEW_COMPONENT_DIRECTORIES) {
    // 顶层组件目录本身是符号链接时不进入视图：copy 不跟随链接，
    // symlink 模式也不应该把插件包外的任意目录直接暴露给运行时。
    if (await isRealDirectory(join(input.rootPath, directory))) {
      componentDirectories.push(directory);
    }
  }

  let hooks: ViewRootHooksPlan | null = null;
  const standardHooksPath = join(input.rootPath, STANDARD_HOOKS_RELATIVE_PATH);
  if (await isRegularFileFollowingLinks(standardHooksPath)) {
    // 文件存在时以文件为准：插件作者已经把 hooks 抽到独立文件，清单里的 hooks 只是兼容字段。
    hooks = { kind: "file", path: standardHooksPath };
  } else if (isPlainRecord(input.manifest.hooks)) {
    // 没有独立文件时把清单内联 hooks 落成 JSON，让运行时只读一种路径。
    hooks = {
      kind: "manifest",
      bytes: Buffer.from(`${stableJson(input.manifest.hooks)}\n`, "utf8"),
    };
  }
  return { componentDirectories, hooks };
}

async function isViewRootCurrent(
  viewRoot: string,
  expectedManifest: Buffer,
  plan: ViewRootPlan,
): Promise<boolean> {
  if (!(await isRealDirectory(viewRoot))) return false;
  let storedManifest: Buffer;
  try {
    storedManifest = await readFile(join(viewRoot, VIEW_MANIFEST_FILE));
  } catch {
    return false;
  }
  if (!storedManifest.equals(expectedManifest)) return false;

  let names: string[];
  try {
    names = (await readdir(viewRoot, { withFileTypes: true }))
      .filter((entry) => entry.name !== VIEW_MANIFEST_FILE)
      .map((entry) => entry.name);
  } catch {
    return false;
  }
  const expected = [
    ...plan.componentDirectories,
    ...(plan.hooks ? [VIEW_HOOKS_FILE] : []),
  ].sort();
  names.sort();
  return (
    names.length === expected.length &&
    names.every((name, index) => name === expected[index])
  );
}

/**
 * 判断已有视图根的物化方式。
 *
 * 组件目录都是链接即 symlink；没有组件目录时无从判断，回退到本次请求的模式。
 * 清单里刻意不记录 mode：`nibiViewRoot` 只保存来源元数据，避免把可变实现细节写进字节比对。
 */
async function detectViewRootMode(
  viewRoot: string,
  plan: ViewRootPlan,
  requestedMode: ViewRootMode,
): Promise<ViewRootMode> {
  if (plan.componentDirectories.length === 0) return requestedMode;
  for (const directory of plan.componentDirectories) {
    try {
      if (!(await lstat(join(viewRoot, directory))).isSymbolicLink()) return "copy";
    } catch {
      return "copy";
    }
  }
  return "symlink";
}

async function writeStagedViewRoot(
  stagedPath: string,
  input: MaterializePluginViewRootInput,
  plan: ViewRootPlan,
  manifestBytes: Buffer,
  mode: ViewRootMode,
): Promise<void> {
  await mkdir(stagedPath, { recursive: true });
  await writeFile(join(stagedPath, VIEW_MANIFEST_FILE), manifestBytes);
  for (const directory of plan.componentDirectories) {
    const source = join(input.rootPath, directory);
    const destination = join(stagedPath, directory);
    if (mode === "symlink") {
      await symlinkDirectory(source, destination);
    } else {
      await copyDirectoryTree(source, destination);
    }
  }
  if (plan.hooks) {
    const destination = join(stagedPath, VIEW_HOOKS_FILE);
    if (plan.hooks.kind === "file" && plan.hooks.path) {
      await copyFile(plan.hooks.path, destination);
    } else if (plan.hooks.bytes) {
      await writeFile(destination, plan.hooks.bytes);
    }
  }
}

async function symlinkDirectory(source: string, destination: string): Promise<void> {
  // Windows 只有目录 junction 不需要管理员/开发者模式；文件符号链接需要额外权限，
  // 因此目录一律用 junction，其余平台用 "dir" 保持 POSIX 语义。
  const type = process.platform === "win32" ? "junction" : "dir";
  // junction 的目标必须是绝对路径；相对源码根会让链接指向不可预测的位置。
  await symlink(resolve(source), destination, type);
}

async function copyDirectoryTree(source: string, destination: string): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  await mkdir(destination, { recursive: true });
  for (const entry of entries) {
    // Dirent 不跟随链接，isSymbolicLink 能识别目录/文件链接；
    // 跳过链接可以避免把插件根之外的内容带进视图，也避免链接环导致无限递归。
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIPPED_COPY_DIRECTORIES.has(entry.name)) continue;
      await copyDirectoryTree(
        join(source, entry.name),
        join(destination, entry.name),
      );
      continue;
    }
    if (entry.isFile()) {
      await copyFile(join(source, entry.name), join(destination, entry.name));
    }
  }
}

async function replaceViewRootAtomically(
  stagedPath: string,
  viewRoot: string,
): Promise<void> {
  const backupPath = `${viewRoot}.old-${process.pid}-${randomUUID()}`;
  let movedExisting = false;
  if (await pathExists(viewRoot)) {
    // POSIX 与 Windows 都不允许 rename 覆盖非空目标目录，只能先把旧版本挪到备份名；
    // 这样新版本 rename 成功前，旧版本始终是完整可读状态，只是路径暂时换了名字。
    await rename(viewRoot, backupPath);
    movedExisting = true;
  }
  try {
    await rename(stagedPath, viewRoot);
  } catch (error) {
    if (movedExisting && !(await pathExists(viewRoot))) {
      try {
        await rename(backupPath, viewRoot);
      } catch {
        // 回滚也失败时保留 backup 供恢复；原始错误才是调用方需要看到的失败原因。
      }
    }
    throw error;
  }
  if (movedExisting) await removeTreeBestEffort(backupPath);
}

/**
 * 只读意图：文件 0444、目录 0555。
 *
 * Windows 上 chmod 对目录基本无效，受限文件系统也可能拒绝；这里全部 best-effort，
 * 因为只读是防御性加固，不是功能前提，不能因为权限设置失败让物化整体失败。
 */
async function chmodTreeReadOnly(root: string): Promise<void> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      // 链接的权限属于链接目标（可能是插件源目录），修改它会越权污染外部目录。
      if (entry.isSymbolicLink()) continue;
      const target = join(root, entry.name);
      if (entry.isDirectory()) {
        await chmodTreeReadOnly(target);
        continue;
      }
      if (entry.isFile()) {
        try {
          await chmod(target, 0o444);
        } catch {
          // Windows 只读属性/受限 FS：忽略。
        }
      }
    }
    try {
      await chmod(root, 0o555);
    } catch {
      // 同上。
    }
  } catch {
    // 遍历失败（权限/竞态）时放弃加固，不影响已经写好的视图。
  }
}

async function removeTreeBestEffort(path: string): Promise<void> {
  try {
    await rm(path, { force: true, maxRetries: 2, recursive: true, retryDelay: 25 });
    return;
  } catch {
    // 只读目录在 POSIX 上无法直接删除子项，先恢复可写再试一次。
  }
  try {
    await chmodTreeWritable(path);
    await rm(path, { force: true, maxRetries: 2, recursive: true, retryDelay: 25 });
  } catch {
    // best-effort：清理失败不能覆盖主操作结果；残留临时目录会被列举逻辑过滤。
  }
}

async function chmodTreeWritable(path: string): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    let entries: Dirent[] | null = null;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      entries = null;
    }
    for (const entry of entries ?? []) {
      if (entry.isSymbolicLink()) continue;
      await chmodTreeWritable(join(path, entry.name));
    }
    try {
      await chmod(path, 0o755);
    } catch {
      // 恢复失败时由调用方的第二次 rm 或下一次重试兜底。
    }
    return;
  }
  if (info.isFile()) {
    try {
      await chmod(path, 0o644);
    } catch {
      // 同上。
    }
  }
}

function chmodTreeWritableSync(path: string): void {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    let names: string[] = [];
    try {
      names = readdirSync(path);
    } catch {
      names = [];
    }
    for (const name of names) chmodTreeWritableSync(join(path, name));
    try {
      chmodSync(path, 0o755);
    } catch {
      // Windows/受限 FS 上目录权限无语义，忽略。
    }
    return;
  }
  if (info.isFile()) {
    try {
      chmodSync(path, 0o644);
    } catch {
      // 同上。
    }
  }
}

function createStagingPath(viewRoot: string): string {
  // pid 便于定位哪个进程留下的残骸，uuid 防止同一进程并发物化互相覆盖。
  return `${viewRoot}.tmp-${process.pid}-${randomUUID()}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function isRealDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isRegularFileFollowingLinks(path: string): Promise<boolean> {
  try {
    // hooks 文件允许是链接：读取时跟随到真实文件，复制内容而不是复制链接。
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 递归按 key 排序；undefined 字段直接省略，避免 JSON.stringify 在各平台上产生歧义。 */
function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value)) ?? "null";
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!isPlainRecord(value)) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry === undefined) continue;
    sorted[key] = sortJsonValue(entry);
  }
  return sorted;
}
