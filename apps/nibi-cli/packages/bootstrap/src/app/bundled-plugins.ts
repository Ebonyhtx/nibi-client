import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { writeBundledOfficialMarketplacePartitionSync } from "@nibi/adapters/plugins";
import { NIBI_OFFICIAL_PLUGIN_MARKETPLACE, type Logger } from "@nibi/contracts";
import { isNibiCuaInternalFeatureEnabled, NIBI_CUA_OFFICIAL_PLUGIN_ID } from "@nibi/shared";
import {
  createOfficialPluginCacheRetryBudget,
  getOfficialPluginCacheRetryAttempts,
  isTransientOfficialPluginCacheFsError,
  type OfficialPluginCacheRetryBudget,
  removeOfficialPluginCacheDirectory,
  renameOfficialPluginCachePath,
} from "./official-plugin-cache-fs.js";
import {
  OFFICIAL_PLUGIN_DEFINITIONS,
  type OfficialPluginDefinition,
} from "./official-plugin-definitions.js";
import { writeOfficialPluginRuntimeManifest } from "./official-plugin-runtime.js";
import {
  isOfficialPluginSeedLockTimeoutError,
  withOfficialPluginSeedLock,
} from "./official-plugin-seed-lock.js";

const OFFICIAL_PLUGIN_MARKETPLACE = NIBI_OFFICIAL_PLUGIN_MARKETPLACE;
const SEA_PLUGIN_ASSET_PREFIX = "nibi-official-plugins/";
const SEA_PLUGIN_MANIFEST_ASSET_KEY = `${SEA_PLUGIN_ASSET_PREFIX}manifest.json`;
const SEED_MARKER_FILE = ".nibi-plugin-seed.json";
const SEED_MARKER_VERSION = 1;
const SHA256_HEX_PATTERN = /^[\da-f]{64}$/iu;
const SEED_LOCK_TOTAL_BUDGET_MS = 15_000;
/**
 * dev 下改了内置插件源但没升 definition.version 时的显式全量刷新开关。
 * 快路径只信 marker + 缓存完整性；生产升级必须靠 version/marker 变化，不能靠 mtime。
 */
const SEED_FORCE_REFRESH_ENV = "NIBI_OFFICIAL_PLUGIN_SEED_FORCE_REFRESH";
/** memo 语义变化时手动 +1，防止升级后的进程复用旧键。 */
const SEED_MEMO_REVISION = 1;
const SEED_MEMO_MAX_ENTRIES = 4;

const includedTopLevelPaths = new Set([
  "plugin.json",
  "mcp.json",
  "README.md",
  // 官方内容插件新增 agents 后，filesystem seed 的顶层白名单未同步，目录被静默裁掉。
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  // Browser skill 会从官方插件根目录动态导入 scripts/browser-client.mjs。
  // filesystem seed 若漏掉 scripts，Dev 会连接 node_repl 成功却在首次 Browser Use 时导入失败。
  "scripts",
  "skills",
  "templates",
  // NIBI 的文档四件套在 skills 之外还带 tools/（LibreOffice 引擎、硬判据门禁）。
  // 漏掉这行 = 内置包里整个 tools 目录被静默裁掉，装完插件缺工具。
  "tools",
]);

interface OfficialPluginSeedFile {
  // 扫描时一次读入的字节快照：seed 复制与 sha256 校验必须针对同一份内容，否则并发的
  // 构建/测试在扫描后改写源文件会让校验读到半截产物（2026-11-02 CLI 测试实测）。
  bytes?: Buffer;
  mode?: number;
  path: string;
  sha256: string;
  sourcePath?: string;
}

interface OfficialPluginSeedPluginSource {
  /**
   * marker 已证明目标 cache 与本定义同版本且完整：`files` 为空，hash 直接取 marker。
   * 命中时 seed 只需刷新 runtime manifest，不再读源文件/重算 sha256。
   */
  current?: boolean;
  definition: OfficialPluginDefinition;
  /** 快路径从缓存清单取到的 description，避免为了写 marketplace 再扫一遍源文件。 */
  description?: string;
  files: OfficialPluginSeedFile[];
  hash: string;
  /** current 快路径已从源清单读过一次；仅用于 runtime manifest 重写。 */
  manifestContents?: string;
  missingSeedPaths: string[];
  rootPath?: string;
}

interface OfficialPluginSeedSource {
  kind: "filesystem" | "sea";
  plugins: OfficialPluginSeedPluginSource[];
}

interface SeaOfficialPluginManifest {
  hash: string;
  plugins: Array<{
    files: OfficialPluginSeedFile[];
    marketplace: string;
    name: string;
    version: string;
  }>;
  version: 1;
}

interface OfficialPluginSeedMarker {
  hash: string;
  marketplace: string;
  plugin: string;
  pluginVersion: string;
  source: OfficialPluginSeedSource["kind"];
  version: number;
}

interface OfficialPluginRootsMemoEntry {
  cacheRoots: Array<{
    definition: OfficialPluginDefinition;
    /** 首次 seed 后的 marker hash；并发进程用不同内容重 seed 时据此判失效。 */
    markerHash: string;
    sourceKind: OfficialPluginSeedSource["kind"];
    targetRoot: string;
  }>;
  roots: string[];
  storageRoot: string;
}

type SeaModule = typeof import("node:sea");

/**
 * 进程内 roots memo。Host 与 CLI 各有一份，不能跨进程共享；任何进程内变更
 * （安装/卸载/启停/marketplace 刷新）都必须显式清理，不能假设磁盘状态不变。
 */
const officialPluginRootsMemo = new Map<string, OfficialPluginRootsMemoEntry>();
const OFFICIAL_PLUGIN_DEFINITIONS_BUILD_ID = createHash("sha256")
  .update(
    JSON.stringify(
      OFFICIAL_PLUGIN_DEFINITIONS.map((definition) => [
        definition.name,
        definition.version,
        definition.rootCandidates,
        definition.requiredSeedPaths ?? [],
        definition.runtimeTopLevelPaths ?? [],
      ]),
    ),
  )
  .digest("hex");

export function invalidateOfficialPluginRootsMemo(): void {
  officialPluginRootsMemo.clear();
}

function seedBundledOfficialPlugins(input: {
  logger?: Logger;
  /**
   * 显式宿主前缀，仅供内部/测试使用；转交给 runtime manifest 重写。
   * 不传时由 writeOfficialPluginRuntimeManifest 走生产探测（测试进程下为 undefined）。
   */
  runtimeHostPrefixArgs?: readonly string[];
  source: OfficialPluginSeedSource;
  storageRoot: string;
}): OfficialPluginDefinition[] {
  const source = input.source;

  // Catalog/cache 是内置插件的不可变产品资产；Runtime 是否加载由 discovery 的抑制态决定，
  // 不能在 seed 阶段删除或过滤，否则卸载后详情页无法读取组件，也无法恢复。
  writeOfficialMarketplace(input.storageRoot, source);
  const retryBudget = createOfficialPluginCacheRetryBudget();
  // 等锁超时降级后循环会继续；若每个插件独立重置 15s 等待预算，成组遗留的
  // 锁会让启动同步冻结 N×15s。全部插件共享同一截止时间：无争用的锁仍瞬时获取（mkdir
  // 一次成功不查预算），预算耗尽后有争用的锁立即降级，seeding 总等待封顶 15s。
  const seedLockDeadlineAt = Date.now() + SEED_LOCK_TOTAL_BUDGET_MS;
  const failedSeeds: OfficialPluginDefinition[] = [];
  for (const pluginSource of source.plugins) {
    let plugin = pluginSource;
    const pluginId = `${plugin.definition.name}@${OFFICIAL_PLUGIN_MARKETPLACE}`;
    const targetRoot = officialPluginCacheRoot(input.storageRoot, plugin.definition);
    // 入口旁的插件拷贝可能与新定义错配（升级中的桌面包、旧 checkout 未构建 dist）。
    // 缺 requiredSeedPaths 时 seed 源解析曾直接抛错，一个残缺插件把全部插件连同会话恢复
    // 一起炸成 resumeFailed。残缺只作用于单插件：拒绝写缓存，按既有降级协议告警并回退到可用旧缓存。
    if (plugin.missingSeedPaths.length > 0) {
      warnIncompleteSeed(input.logger, plugin, pluginId, targetRoot);
      failedSeeds.push(plugin.definition);
      continue;
    }
    try {
      withOfficialPluginSeedLock(
        targetRoot,
        () => {
          // marker 命中（且缓存完整）时源文件尚未被扫描：只需要幂等刷新 runtime manifest。
          // 这里仍进 seed lock，保留“另一个进程正在替换 cache”时的等待/降级语义。
          if (plugin.current) {
            cleanupLegacySeedBackup(targetRoot, retryBudget);
            if (plugin.manifestContents !== undefined) {
              const manifestWritten = tryWriteOfficialPluginRuntimeManifest({
                hostPrefixArgs: input.runtimeHostPrefixArgs,
                sourceManifestContents: plugin.manifestContents,
                pluginName: plugin.definition.name,
                retryBudget,
                rootPath: targetRoot,
              });
              if (manifestWritten) return;
            }
            // 非 transient 的清单刷新失败（或源清单不可读）：回退到完整扫描 + 重写缓存，
            // 与旧实现“marker 命中但写 runtime manifest 失败后继续 seed”的终态一致。
            plugin = materializeSeedPluginSource(source, plugin);
            if (plugin.missingSeedPaths.length > 0) {
              warnIncompleteSeed(input.logger, plugin, pluginId, targetRoot);
              failedSeeds.push(plugin.definition);
              return;
            }
          }
          const manifestFile = plugin.files.find((file) => isPluginManifestPath(file.path));
          if (!manifestFile)
            throw new Error(`Bundled plugin manifest is missing: ${plugin.definition.name}`);
          const sourceManifestContents = readSeedFileBytes(source, plugin, manifestFile).toString(
            "utf8",
          );
          // 桌面会并发预热多个 workspace Agent；复制插件资源时，
          // 多进程会互删 target 并在 Windows rename 时触发 EPERM。拿锁后必须二次检查，
          // 让等待者直接复用首个进程已经提交的完整缓存。
          if (isSeedCurrent(targetRoot, plugin)) {
            cleanupLegacySeedBackup(targetRoot, retryBudget);
            const manifestWritten = tryWriteOfficialPluginRuntimeManifest({
              hostPrefixArgs: input.runtimeHostPrefixArgs,
              sourceManifestContents,
              pluginName: plugin.definition.name,
              retryBudget,
              rootPath: targetRoot,
            });
            if (manifestWritten) return;
          }

          const temporaryRoot = `${targetRoot}.tmp-${process.pid}-${Date.now()}`;
          removeOfficialPluginCacheDirectory(temporaryRoot, retryBudget);
          mkdirSync(temporaryRoot, { recursive: true });

          try {
            for (const file of plugin.files) {
              const bytes = readSeedFileBytes(source, plugin, file);
              if (hashBytes(bytes) !== file.sha256) {
                throw new Error(
                  `Bundled plugin asset hash mismatch: ${plugin.definition.name}/${file.path}`,
                );
              }
              const outputPath = join(temporaryRoot, ...file.path.split("/"));
              mkdirSync(dirname(outputPath), { recursive: true });
              writeFileSync(outputPath, bytes);
              chmodSync(outputPath, modeForSeedFile(file.path, file.mode));
            }

            writeFileSync(
              join(temporaryRoot, SEED_MARKER_FILE),
              JSON.stringify(seedMarker(source, plugin), null, 2),
            );
            replaceSeedRoot(temporaryRoot, targetRoot, plugin, retryBudget);
            writeOfficialPluginRuntimeManifest({
              hostPrefixArgs: input.runtimeHostPrefixArgs,
              sourceManifestContents,
              pluginName: plugin.definition.name,
              retryBudget,
              rootPath: targetRoot,
            });
          } catch (error) {
            try {
              removeOfficialPluginCacheDirectory(temporaryRoot, retryBudget);
            } catch {
              // 临时目录清理失败不能覆盖真正的 seed 错误；目录名唯一，不会污染后续加载。
            }
            throw error;
          }
        },
        { timeoutMs: Math.max(0, seedLockDeadlineAt - Date.now()) },
      );
    } catch (error) {
      if (
        isTransientOfficialPluginCacheFsError(error) ||
        // seed lock 等待超时只说明同版本缓存锁被别的进程持有或遗留（Windows 上
        // 删不掉的遗留锁 + PID 复用会让接管长期不触发）。seeding 只是刷新缓存，超时必须
        // 走既有降级协议回退到可用缓存并告警，不能把会话恢复整体炸成 resumeFailed。
        isOfficialPluginSeedLockTimeoutError(error) ||
        // 多个 workspace app 会并发 seed 同一份官方插件缓存。当前进程
        // 写 runtime manifest 时，并发赢家可能已经原子替换整个 targetRoot，连同本进程
        // 的临时文件一起移走，rename 因此返回 ENOENT。只在新 target 已由 marker 证明
        // 完整时降级；目标缺失或仍旧时继续抛错，不能掩盖真实缓存损坏。
        (isNotFoundFsError(error) && isSeedCurrent(targetRoot, plugin))
      ) {
        warnCacheDegraded(input.logger, {
          error,
          operation: "seed_plugin",
          pluginId,
          targetRoot,
        });
        failedSeeds.push(plugin.definition);
        continue;
      }
      throw error;
    }
  }
  return failedSeeds;
}

function tryWriteOfficialPluginRuntimeManifest(input: {
  hostPrefixArgs?: readonly string[];
  sourceManifestContents: string;
  pluginName: string;
  retryBudget: OfficialPluginCacheRetryBudget;
  rootPath: string;
}): boolean {
  try {
    writeOfficialPluginRuntimeManifest(input);
    return true;
  } catch (error) {
    if (isTransientOfficialPluginCacheFsError(error)) throw error;
    return false;
  }
}

export function resolveOfficialPluginRoots(input: {
  env?: NodeJS.ProcessEnv;
  extraRoots?: string[];
  logger?: Logger;
  /**
   * 显式宿主入口前缀（仅内部/测试使用），透传给 runtime manifest 重写。
   *
   * 生产调用方不传：`officialPluginHostPrefixArgs()` 在测试进程里恒为 undefined，
   * 否则 seed 会带着 vitest argv 重写缓存清单；测试要覆盖重写路径时用这个缝注入假前缀。
   */
  runtimeHostPrefixArgs?: readonly string[];
  storageRoot: string;
  suppressedBuiltins?: ReadonlySet<string>;
}): string[] {
  const forceRefresh = isOfficialPluginSeedForceRefresh(input.env);
  const memoKey = officialPluginRootsMemoKey(input, forceRefresh);
  if (!forceRefresh) {
    const memoized = officialPluginRootsMemo.get(memoKey);
    if (memoized) {
      // 命中前做一次低价校验：marker/缓存完整性/并发锁仍在。这样外部的缓存删除、
      // 同版本重 seed、以及正在进行的 seed 都不会被进程内 memo 掩盖。
      if (isOfficialPluginRootsMemoEntryValid(memoized)) return [...memoized.roots];
      officialPluginRootsMemo.delete(memoKey);
    }
  }

  const suppressedBuiltins = new Set(input.suppressedBuiltins ?? []);
  // computer-use 内置 plugin 默认不启用，由 feature flag 控制加载。在 seed/discovery 层门控
  // （而非只隐藏某个 UI 面），这样开关关闭时用户无法经 plugin 列表/marketplace/MCP 设置/CLI 命令看到它。
  if (!isNibiCuaInternalFeatureEnabled(input.env ?? process.env)) {
    suppressedBuiltins.add(NIBI_CUA_OFFICIAL_PLUGIN_ID);
  }
  const source = resolveSeedSource({
    forceRefresh,
    storageRoot: input.storageRoot,
  });
  const failedSeeds = source
    ? seedBundledOfficialPlugins({
        logger: input.logger,
        runtimeHostPrefixArgs: input.runtimeHostPrefixArgs,
        source,
        storageRoot: input.storageRoot,
      })
    : [];

  const fallbackRoots = failedSeeds.flatMap((definition) => {
    // CUA 的 frame contract 随 wrapper 与 producer 原子升级。加载旧版本
    // cache 会把旧 block 布局接到新 consumer 上；当前 cache 不可用时宁可不注册 CUA。
    if (`${definition.name}@${OFFICIAL_PLUGIN_MARKETPLACE}` === NIBI_CUA_OFFICIAL_PLUGIN_ID) {
      return [];
    }
    const fallbackRoot = findUsableOfficialPluginFallback(input.storageRoot, definition);
    return fallbackRoot ? [fallbackRoot] : [];
  });
  const roots = uniquePaths([...(input.extraRoots ?? []), ...fallbackRoots]);

  // 只有“全部插件都按当前版本就绪”才进 memo；任何降级都要让下次调用重新走完整路径，
  // 否则一次暂时性 EPERM 会被内存缓存固化成进程级假成功。
  if (!forceRefresh && source && failedSeeds.length === 0) {
    const entry = createOfficialPluginRootsMemoEntry(input.storageRoot, source, roots);
    if (entry) rememberOfficialPluginRoots(memoKey, entry);
  }
  return roots;
}

function isOfficialPluginSeedForceRefresh(env: NodeJS.ProcessEnv | undefined): boolean {
  const raw = (env ?? process.env)[SEED_FORCE_REFRESH_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * memo 键：storageRoot + 抑制/启用相关集合 + 官方插件定义 build id + 影响 seed 的环境。
 *
 * Host 与 CLI 进程各自持有一份 memo（模块级 Map），不跨进程共享；进程内任何插件安装/
 * 卸载/启停/marketplace 变更都必须调用 {@link invalidateOfficialPluginRootsMemo}。
 */
function officialPluginRootsMemoKey(
  input: {
    env?: NodeJS.ProcessEnv;
    extraRoots?: string[];
    runtimeHostPrefixArgs?: readonly string[];
    storageRoot: string;
    suppressedBuiltins?: ReadonlySet<string>;
  },
  forceRefresh: boolean,
): string {
  return JSON.stringify({
    entrypoint: process.argv[1] ?? "",
    extraRoots: input.extraRoots ?? [],
    forceRefresh,
    hostBinaryPath: process.env.NIBI_BUNDLED_AGENT_BINARY_PATH ?? "",
    hostPrefixArgs: input.runtimeHostPrefixArgs ?? null,
    officialDefinitions: OFFICIAL_PLUGIN_DEFINITIONS_BUILD_ID,
    cuaEnabled: isNibiCuaInternalFeatureEnabled(input.env ?? process.env),
    resourceDir: process.env.NIBI_BUNDLED_AGENT_RESOURCE_DIR ?? "",
    revision: SEED_MEMO_REVISION,
    storageRoot: resolve(input.storageRoot),
    suppressedBuiltins: [...(input.suppressedBuiltins ?? [])].sort(),
    workingDirectory: process.cwd(),
  });
}

function createOfficialPluginRootsMemoEntry(
  storageRoot: string,
  source: OfficialPluginSeedSource,
  roots: string[],
): OfficialPluginRootsMemoEntry | undefined {
  const cacheRoots = source.plugins.flatMap((plugin) => {
    const targetRoot = officialPluginCacheRoot(storageRoot, plugin.definition);
    const marker = readSeedMarker(targetRoot);
    return marker
      ? [
          {
            definition: plugin.definition,
            markerHash: marker.hash,
            sourceKind: source.kind,
            targetRoot,
          },
        ]
      : [];
  });
  if (cacheRoots.length === 0) return undefined;
  return { cacheRoots, roots: [...roots], storageRoot };
}

function rememberOfficialPluginRoots(
  memoKey: string,
  entry: OfficialPluginRootsMemoEntry,
): void {
  officialPluginRootsMemo.delete(memoKey);
  officialPluginRootsMemo.set(memoKey, entry);
  while (officialPluginRootsMemo.size > SEED_MEMO_MAX_ENTRIES) {
    const oldestKey = officialPluginRootsMemo.keys().next().value;
    if (oldestKey === undefined) break;
    officialPluginRootsMemo.delete(oldestKey);
  }
}

function isOfficialPluginRootsMemoEntryValid(entry: OfficialPluginRootsMemoEntry): boolean {
  // 目录文件被外部清掉时，overview/detail 会失去 catalog；一次 exists 检查换重新落盘。
  const marketplaceRoot = join(
    entry.storageRoot,
    "marketplaces",
    OFFICIAL_PLUGIN_MARKETPLACE,
  );
  if (
    !existsSync(join(marketplaceRoot, "bundled-marketplace.json")) ||
    !existsSync(join(marketplaceRoot, "marketplace.json"))
  ) {
    return false;
  }
  for (const cacheRoot of entry.cacheRoots) {
    // 有锁说明另一个进程正在替换同一份缓存；本次必须走真实 seed 路径，不能复用旧结果。
    if (existsSync(`${cacheRoot.targetRoot}.seed-lock`)) return false;
    const current = readCurrentSeedState(
      cacheRoot.targetRoot,
      cacheRoot.definition,
      cacheRoot.sourceKind,
      false,
    );
    if (!current || current.hash !== cacheRoot.markerHash) return false;
  }
  return true;
}

function resolveSeedSource(input: {
  forceRefresh: boolean;
  storageRoot: string;
}): OfficialPluginSeedSource | undefined {
  const seaSource = resolveSeaSeedSource();
  if (seaSource) return seaSource;
  return resolveFilesystemSeedSource(input);
}

function resolveSeaSeedSource(): OfficialPluginSeedSource | undefined {
  const sea = getSeaModule();
  if (!sea?.isSea()) return undefined;

  const manifest = readSeaManifest(sea);
  if (!manifest) return undefined;
  const plugins = OFFICIAL_PLUGIN_DEFINITIONS.flatMap((definition) => {
    const plugin = manifest.plugins.find(
      (item) =>
        item.marketplace === OFFICIAL_PLUGIN_MARKETPLACE &&
        item.name === definition.name &&
        item.version === definition.version,
    );
    if (!plugin) return [];
    return [
      {
        definition,
        files: plugin.files,
        hash: hashSeedFiles(plugin.files),
        missingSeedPaths: findMissingOfficialPluginSeedPaths(definition, plugin.files),
      },
    ];
  });
  if (plugins.length === 0) return undefined;

  return {
    kind: "sea",
    plugins,
  };
}

function resolveFilesystemSeedSource(input: {
  forceRefresh: boolean;
  storageRoot: string;
}): OfficialPluginSeedSource | undefined {
  const plugins = OFFICIAL_PLUGIN_DEFINITIONS.flatMap((definition) => {
    const rootPath = resolveFilesystemPluginRoot(definition);
    if (!rootPath) return [];
    const targetRoot = officialPluginCacheRoot(input.storageRoot, definition);
    // 先看 marker + 缓存完整性，再决定是否扫描源。生产升级靠 definition.version 换目录，
    // 不会产生“同目录旧 marker”；dev 未升版本时用 SEED_FORCE_REFRESH_ENV 强制全量。
    const current = readCurrentSeedState(
      targetRoot,
      definition,
      "filesystem",
      input.forceRefresh,
    );
    if (current) {
      // runtime manifest 重写需要“未重写过的源清单”，只读这一个文件，不扫 42MB 资源。
      const manifestContents = readFilesystemPluginManifestContents(rootPath, definition);
      if (manifestContents !== undefined) {
        return [
          {
            current: true,
            definition,
            ...(current.description ? { description: current.description } : {}),
            files: [],
            hash: current.hash,
            manifestContents,
            missingSeedPaths: [],
            rootPath,
          },
        ];
      }
    }
    const files = collectFilesystemPluginFiles(rootPath, definition);
    const missingSeedPaths = findMissingOfficialPluginSeedPaths(definition, files);
    return [
      {
        definition,
        files,
        hash: hashSeedFiles(files),
        missingSeedPaths,
        rootPath,
      },
    ];
  });
  if (plugins.length === 0) return undefined;
  return {
    kind: "filesystem",
    plugins,
  };
}

function readFilesystemPluginManifestContents(
  rootPath: string,
  definition: OfficialPluginDefinition,
): string | undefined {
  try {
    return readFileSync(join(rootPath, ...manifestRelativeSegments(definition)), "utf8");
  } catch {
    return undefined;
  }
}

/**
 * marker 命中且 cache 仍完整时返回缓存态。只读 marker + 缓存 manifest + requiredSeedPaths
 * 的存在性（十几次 sync stat），不读源文件、不算 sha256。
 */
function readCurrentSeedState(
  targetRoot: string,
  definition: OfficialPluginDefinition,
  sourceKind: OfficialPluginSeedSource["kind"],
  forceRefresh: boolean,
): { description?: string; hash: string } | undefined {
  if (forceRefresh) return undefined;
  const marker = readSeedMarker(targetRoot);
  if (
    !marker ||
    marker.version !== SEED_MARKER_VERSION ||
    marker.marketplace !== OFFICIAL_PLUGIN_MARKETPLACE ||
    marker.plugin !== definition.name ||
    marker.pluginVersion !== definition.version ||
    marker.source !== sourceKind
  ) {
    return undefined;
  }
  const manifest = readUsableSeedCacheManifest(targetRoot, definition);
  if (!manifest) return undefined;
  return {
    ...(typeof manifest.description === "string" && manifest.description.trim().length > 0
      ? { description: manifest.description }
      : {}),
    hash: marker.hash,
  };
}

function readSeedMarker(targetRoot: string): OfficialPluginSeedMarker | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(join(targetRoot, SEED_MARKER_FILE), "utf8"),
    ) as unknown;
    if (!isRecord(parsed)) return undefined;
    if (
      typeof parsed.hash !== "string" ||
      // marker 被截断/篡改成非 sha256 形态时不能当作内容身份命中；宁可重扫一次。
      !SHA256_HEX_PATTERN.test(parsed.hash) ||
      typeof parsed.marketplace !== "string" ||
      typeof parsed.plugin !== "string" ||
      typeof parsed.pluginVersion !== "string" ||
      (parsed.source !== "filesystem" && parsed.source !== "sea") ||
      typeof parsed.version !== "number"
    ) {
      return undefined;
    }
    return {
      hash: parsed.hash,
      marketplace: parsed.marketplace,
      plugin: parsed.plugin,
      pluginVersion: parsed.pluginVersion,
      source: parsed.source,
      version: parsed.version,
    };
  } catch {
    return undefined;
  }
}

function readUsableSeedCacheManifest(
  targetRoot: string,
  definition: OfficialPluginDefinition,
): Record<string, unknown> | undefined {
  let manifest: unknown;
  try {
    manifest = JSON.parse(
      readFileSync(join(targetRoot, ...manifestRelativeSegments(definition)), "utf8"),
    );
  } catch {
    return undefined;
  }
  if (!isRecord(manifest) || manifest.name !== definition.name) return undefined;
  return (definition.requiredSeedPaths ?? []).every((requiredPath) =>
    existsSync(join(targetRoot, ...requiredPath.split("/"))),
  )
    ? manifest
    : undefined;
}

function materializeSeedPluginSource(
  source: OfficialPluginSeedSource,
  plugin: OfficialPluginSeedPluginSource,
): OfficialPluginSeedPluginSource {
  // SEA 的文件清单本来就在内存里，current 快路径不会丢掉它；只需退回普通复制分支。
  if (source.kind !== "filesystem" || !plugin.rootPath) {
    return { ...plugin, current: false };
  }
  const files = collectFilesystemPluginFiles(plugin.rootPath, plugin.definition);
  return {
    ...plugin,
    current: false,
    files,
    hash: hashSeedFiles(files),
    manifestContents: undefined,
    missingSeedPaths: findMissingOfficialPluginSeedPaths(plugin.definition, files),
  };
}

export function findMissingOfficialPluginSeedPaths(
  definition: Pick<OfficialPluginDefinition, "requiredSeedPaths">,
  files: ReadonlyArray<{ path: string }>,
): string[] {
  const availablePaths = new Set(files.map((file) => file.path));
  return (definition.requiredSeedPaths ?? []).filter(
    (requiredPath) => !availablePaths.has(requiredPath),
  );
}

function getSeaModule(): SeaModule | undefined {
  const getBuiltinModule = process.getBuiltinModule as ((id: "node:sea") => SeaModule) | undefined;
  try {
    return getBuiltinModule?.("node:sea");
  } catch {
    return undefined;
  }
}

function readSeaManifest(sea: SeaModule): SeaOfficialPluginManifest | undefined {
  try {
    const raw = sea.getAsset(SEA_PLUGIN_MANIFEST_ASSET_KEY, "utf8");
    const manifest = JSON.parse(raw) as SeaOfficialPluginManifest;
    return manifest.version === 1 && Array.isArray(manifest.plugins) ? manifest : undefined;
  } catch {
    return undefined;
  }
}

function resolveFilesystemPluginRoot(definition: OfficialPluginDefinition): string | undefined {
  for (const baseDir of candidateBaseDirs()) {
    for (const relativePath of definition.rootCandidates) {
      const rootPath = resolve(baseDir, relativePath);
      if (isPluginRoot(rootPath)) return rootPath;
    }
  }
  return undefined;
}

function collectFilesystemPluginFiles(
  rootPath: string,
  definition: OfficialPluginDefinition,
): OfficialPluginSeedFile[] {
  const files: OfficialPluginSeedFile[] = [];
  const allowedTopLevelPaths = new Set([
    ...includedTopLevelPaths,
    ...(definition.runtimeTopLevelPaths ?? []),
  ]);
  for (const sourcePath of walkFiles(rootPath, allowedTopLevelPaths)) {
    const relativePath = toPosixPath(sourcePath.slice(rootPath.length + 1));
    if (!shouldIncludePluginFile(relativePath, allowedTopLevelPaths)) continue;
    const bytes = readFileSync(sourcePath);
    files.push({
      bytes,
      mode: modeForSeedFile(relativePath, statSync(sourcePath).mode),
      path: relativePath,
      sha256: hashBytes(bytes),
      sourcePath,
    });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function* walkFiles(
  directory: string,
  allowedTopLevelPaths: ReadonlySet<string>,
  depth = 0,
): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (shouldSkipDirectory(entry.name, depth, allowedTopLevelPaths)) continue;
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath, allowedTopLevelPaths, depth + 1);
      continue;
    }
    if (entry.isFile()) yield fullPath;
  }
}

function readSeedFileBytes(
  source: OfficialPluginSeedSource,
  plugin: OfficialPluginSeedPluginSource,
  file: OfficialPluginSeedFile,
): Buffer {
  if (source.kind === "filesystem" && file.sourcePath) {
    return file.bytes ?? readFileSync(file.sourcePath);
  }
  const sea = getSeaModule();
  if (!sea?.isSea()) throw new Error("SEA plugin asset is unavailable outside SEA runtime.");
  return Buffer.from(
    sea.getRawAsset(
      `${SEA_PLUGIN_ASSET_PREFIX}${OFFICIAL_PLUGIN_MARKETPLACE}/${plugin.definition.name}/${plugin.definition.version}/${file.path}`,
    ),
  );
}

function writeOfficialMarketplace(storageRoot: string, source: OfficialPluginSeedSource): void {
  writeBundledOfficialMarketplacePartitionSync({
    manifest: {
      name: OFFICIAL_PLUGIN_MARKETPLACE,
      plugins: source.plugins.map((plugin) => {
        // 商店信息（listing）与描述随目录条目下发：键名与 CDN 目录 schema 一致，
        // 由 adapter 的同一套 parseEntryStoreListing 解析，UI 才能给内置插件渲染
        // 显示名/分类/作者/示例提示词。描述取自插件包内 plugin.json（单一事实源）；
        // marker 命中时源文件未扫描，描述来自同一份被 marker 证明最新的缓存清单。
        const description = plugin.description ?? readSeedPluginDescription(source, plugin);
        return {
          cachePath: officialPluginCacheRoot(storageRoot, plugin.definition),
          // 未安装/已卸载时商店读目录条目的 componentTypes 判断「UI 插件」；缺失会掉进分类分组。
          ...(plugin.definition.componentTypes
            ? { componentTypes: [...plugin.definition.componentTypes] }
            : {}),
          ...(description ? { description } : {}),
          name: plugin.definition.name,
          source: source.kind,
          version: plugin.definition.version,
          ...(plugin.definition.listing ?? {}),
        };
      }),
      version: 1,
    },
    storageRoot,
  });
}

/** 从 seed 文件集中读插件 plugin.json 的 description；读取/解析失败按 undefined 降级。 */
function readSeedPluginDescription(
  source: OfficialPluginSeedSource,
  plugin: OfficialPluginSeedPluginSource,
): string | undefined {
  const manifestFile = plugin.files.find((file) => isPluginManifestPath(file.path));
  if (!manifestFile) return undefined;
  try {
    const parsed = JSON.parse(readSeedFileBytes(source, plugin, manifestFile).toString("utf8")) as {
      description?: unknown;
    };
    return typeof parsed.description === "string" && parsed.description.trim().length > 0
      ? parsed.description
      : undefined;
  } catch {
    return undefined;
  }
}

function isSeedCurrent(targetRoot: string, plugin: OfficialPluginSeedPluginSource): boolean {
  const marker = readSeedMarker(targetRoot);
  return (
    marker !== undefined &&
    marker.hash === plugin.hash &&
    marker.pluginVersion === plugin.definition.version &&
    // marker 只证明“上次 seed 的内容身份”，不能证明缓存文件还在：被外部清掉/截断的
    // requiredSeedPaths 必须重新落盘，不能被 marker 短路成假成功。
    readUsableSeedCacheManifest(targetRoot, plugin.definition) !== undefined
  );
}

/**
 * 旧版本缓存只要插件清单和运行所需文件完整，就可以继续服务当前会话。
 * marker hash 不匹配只表示需要升级，不能把一个可用的旧缓存当成启动失败。
 */
function isSeedUsable(targetRoot: string, definition: OfficialPluginDefinition): boolean {
  return readUsableSeedCacheManifest(targetRoot, definition) !== undefined;
}

function findUsableOfficialPluginFallback(
  storageRoot: string,
  definition: OfficialPluginDefinition,
): string | undefined {
  const targetRoot = officialPluginCacheRoot(storageRoot, definition);
  if (isSeedUsable(targetRoot, definition)) return undefined;

  let entries;
  try {
    entries = readdirSync(dirname(targetRoot), { withFileTypes: true });
  } catch (error) {
    if (isNotFoundFsError(error)) return undefined;
    throw error;
  }

  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== definition.version &&
        !entry.name.includes(".backup") &&
        // 锁目录（含 .seed-lock.stale-*）与版本目录同级；超时降级后锁必然在场，
        // 不能依赖 isSeedUsable 的内容检查兜底，按名字直接排除。
        !entry.name.includes(".seed-lock") &&
        !entry.name.includes(".tmp-"),
    )
    .sort((left, right) =>
      right.name.localeCompare(left.name, undefined, { numeric: true, sensitivity: "base" }),
    )
    .map((entry) => join(dirname(targetRoot), entry.name))
    .find((rootPath) => isSeedUsable(rootPath, definition));
}

function replaceSeedRoot(
  temporaryRoot: string,
  targetRoot: string,
  plugin: OfficialPluginSeedPluginSource,
  retryBudget: OfficialPluginCacheRetryBudget,
): void {
  const backupRoot = createSeedBackupRoot(targetRoot);
  let movedTargetToBackup = false;
  mkdirSync(dirname(targetRoot), { recursive: true });
  if (existsSync(targetRoot)) {
    try {
      renameOfficialPluginCachePath(targetRoot, backupRoot, retryBudget);
      movedTargetToBackup = true;
    } catch (error) {
      // 官方插件缓存由桌面窗口、协议与 CLI 入口共享。existsSync 之后，
      // 另一个进程可能先移走 target；此处只收敛这个 TOCTOU 的 ENOENT，随后继续
      // promote 或由 isSeedCurrent 识别并发赢家，其他缺失错误仍保持原有 fatal 语义。
      if (!isNotFoundFsError(error)) throw error;
    }
  }

  try {
    renameOfficialPluginCachePath(temporaryRoot, targetRoot, retryBudget);
  } catch (error) {
    if (isSeedCurrent(targetRoot, plugin)) {
      removeOfficialPluginCacheDirectory(temporaryRoot, retryBudget);
      if (movedTargetToBackup) {
        removeOfficialPluginCacheDirectory(backupRoot, retryBudget);
      }
      cleanupLegacySeedBackup(targetRoot, retryBudget);
      return;
    }
    if (movedTargetToBackup && !existsSync(targetRoot) && existsSync(backupRoot)) {
      renameOfficialPluginCachePath(backupRoot, targetRoot, retryBudget);
    }
    throw error;
  }

  if (movedTargetToBackup) {
    removeOfficialPluginCacheDirectory(backupRoot, retryBudget);
  }
  cleanupLegacySeedBackup(targetRoot, retryBudget);
}

function cleanupLegacySeedBackup(
  targetRoot: string,
  retryBudget: OfficialPluginCacheRetryBudget,
): void {
  const backupRoot = `${targetRoot}.backup`;
  if (!existsSync(backupRoot)) return;

  // 旧版固定 backup 没有事务归属，target 暂时缺失时可能属于另一个仍在
  // promote 的进程，不能把它恢复回去。仅在当前 seed 已确认可用后清理这个遗留目录。
  removeOfficialPluginCacheDirectory(backupRoot, retryBudget);
}

function createSeedBackupRoot(targetRoot: string): string {
  // 固定 backup 会被并发启动进程共同当作 rollback 点；每次替换使用唯一目录，
  // catch 分支只恢复自己移动出的 target，避免一个进程窃取另一个进程的事务状态。
  return `${targetRoot}.backup-${process.pid}-${Date.now()}`;
}

function isNotFoundFsError(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === "object" &&
    error !== null &&
    String((error as NodeJS.ErrnoException).code) === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warnIncompleteSeed(
  logger: Logger | undefined,
  plugin: OfficialPluginSeedPluginSource,
  pluginId: string,
  targetRoot: string,
): void {
  warnCacheDegraded(logger, {
    error: Object.assign(
      new Error(
        `Bundled official plugin ${plugin.definition.name} is missing required seed assets: ${plugin.missingSeedPaths.join(", ")}`,
      ),
      { code: "NIBI_PLUGIN_SEED_INCOMPLETE" },
    ),
    missingSeedPaths: plugin.missingSeedPaths,
    operation: "seed_plugin",
    pluginId,
    targetRoot,
  });
}

function warnCacheDegraded(
  logger: Logger | undefined,
  input: {
    error: NodeJS.ErrnoException;
    missingSeedPaths?: readonly string[];
    operation: "remove_suppressed_plugin" | "seed_plugin";
    pluginId: string;
    targetRoot: string;
  },
): void {
  logger?.warn("Official plugin cache operation degraded", {
    attempts: getOfficialPluginCacheRetryAttempts(input.error),
    degraded: true,
    errorCode: input.error.code,
    ...(input.missingSeedPaths ? { missingSeedPaths: input.missingSeedPaths } : {}),
    module: "bootstrap.official_plugin_cache",
    operation: input.operation,
    pluginId: input.pluginId,
    targetRoot: input.targetRoot,
  });
}

function seedMarker(
  source: OfficialPluginSeedSource,
  plugin: OfficialPluginSeedPluginSource,
): OfficialPluginSeedMarker {
  return {
    hash: plugin.hash,
    marketplace: OFFICIAL_PLUGIN_MARKETPLACE,
    plugin: plugin.definition.name,
    pluginVersion: plugin.definition.version,
    source: source.kind,
    version: SEED_MARKER_VERSION,
  };
}

function officialPluginCacheRoot(
  storageRoot: string,
  definition: OfficialPluginDefinition,
): string {
  return join(
    storageRoot,
    "cache",
    OFFICIAL_PLUGIN_MARKETPLACE,
    definition.name,
    definition.version,
  );
}

/** 内置技能包（bundled-skills.ts）沿同一组候选目录定位，保证两类内置资产在每种运行布局下同进同出。 */
export function candidateBaseDirs(): string[] {
  // 修复原因：Electron app-server 运行在 resources/nibi/nibi.cjs，官方插件资源也随桌面包
  // stage 到同级 packages/*-plugin。候选目录必须优先看入口文件目录，避免生产态退回到
  // monorepo-only 的 __dirname 查找假设。
  // Host 进程的入口是 out/host/index.js，既不在 resources/nibi 也不在 monorepo 包里；
  // main 通过 NIBI_BUNDLED_AGENT_RESOURCE_DIR 把随包资源目录显式传进来，必须排在最前。
  const bundledResourceDir = process.env.NIBI_BUNDLED_AGENT_RESOURCE_DIR?.trim();
  return [
    ...new Set(
      [bundledResourceDir, entrypointDir(), runtimeDir(), process.cwd()].filter(
        (dir): dir is string => typeof dir === "string" && dir.length > 0,
      ),
    ),
  ];
}

function runtimeDir(): string | undefined {
  return typeof __dirname === "string" ? __dirname : undefined;
}

function entrypointDir(): string | undefined {
  return process.argv[1] ? dirname(process.argv[1]) : undefined;
}

function shouldSkipDirectory(
  name: string,
  depth: number,
  allowedTopLevelPaths: ReadonlySet<string>,
): boolean {
  if (name === ".turbo" || name === "coverage" || name === ".venv" || name === "__pycache__") {
    return true;
  }
  return name === "node_modules" && !(depth === 0 && allowedTopLevelPaths.has(name));
}

function shouldIncludePluginFile(
  relativePath: string,
  allowedTopLevelPaths: ReadonlySet<string>,
): boolean {
  const segments = relativePath.split("/");
  if (segments.includes(".DS_Store") || segments.some((segment) => segment.endsWith(".pyc"))) {
    return false;
  }
  const [topLevel] = relativePath.split("/");
  return topLevel !== undefined && allowedTopLevelPaths.has(topLevel);
}

function modeForSeedFile(filePath: string, sourceMode?: number): number {
  if (sourceMode !== undefined && (sourceMode & 0o111) !== 0) return 0o755;

  const normalizedPath = toPosixPath(filePath);
  // official plugin seed 会重写缓存文件权限。部分插件通过 polyglot shell wrapper
  // 直接执行 hook 脚本，若落盘成 0644 会 permission denied。这里保留源码执行位，
  // 并对 SEA/旧 manifest 缺少 mode 的 hook 脚本兜底。
  if (/(?:^|\/)dist\/mcp\/server\.js$/i.test(normalizedPath)) return 0o755;
  if (/^hooks\//u.test(normalizedPath) && !/\.(json|md|txt)$/iu.test(normalizedPath)) {
    return 0o755;
  }

  return 0o644;
}

function hashSeedFiles(files: OfficialPluginSeedFile[]): string {
  return hashText(
    JSON.stringify(
      files.map((file) => [file.path, file.sha256, modeForSeedFile(file.path, file.mode)]),
    ),
  );
}

function toPosixPath(value: string): string {
  return value.split(sep).join("/");
}

function uniquePaths(paths: string[]): string[] {
  return paths.filter((path, index) => paths.indexOf(path) === index);
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hashText(text: string): string {
  return hashBytes(Buffer.from(text));
}

/**
 * 清单路径判定：插件包使用 Agent Plugins 根 `plugin.json`。
 * 旧 `.claude-plugin`/`.codex-plugin` 不再参与 seed。
 */
const PLUGIN_MANIFEST_RELATIVE_PATH = "plugin.json";

function isPluginManifestPath(path: string): boolean {
  return path === PLUGIN_MANIFEST_RELATIVE_PATH;
}

/** 该目录下是否已经有一个可识别的插件清单。 */
function isPluginRoot(rootPath: string): boolean {
  return existsSync(join(rootPath, PLUGIN_MANIFEST_RELATIVE_PATH));
}

/**
 * 从 definition.requiredSeedPaths 里找清单文件，派生 `<dir>/plugin.json` 路径段。
 * 找不到时按 NIBI 自有格式兜底（内置件都带这一项，兜底只是防挂）。
 */
function manifestRelativeSegments(definition: OfficialPluginDefinition): string[] {
  const manifest = (definition.requiredSeedPaths ?? []).find((path) =>
    isPluginManifestPath(path),
  );
  return (manifest ?? "plugin.json").split("/");
}
