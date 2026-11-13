import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { getRuntimeToolRuntime, type RuntimeToolId } from "@nibi/shared/runtime-tool-runtime";

type CliEnv = Record<string, string | undefined>;

export interface SeaRuntimeModule {
  getAsset(key: string, encoding: "utf8"): string;
  getRawAsset(key: string): ArrayBuffer;
  isSea(): boolean;
}

interface SeaRuntimeTool {
  binaryName: string;
  id: RuntimeToolId;
  sha256: string;
  size: number;
  version: string;
}

interface SeaRuntimeToolManifest {
  target: string;
  tools: SeaRuntimeTool[];
  version: 1;
}

interface RuntimeToolMarker {
  binaryName: string;
  id: RuntimeToolId;
  sha256: string;
  size: number;
  target: string;
  toolVersion: string;
  version: 1;
}

export interface EnsureSeaRuntimeToolsOptions {
  arch?: string;
  env?: CliEnv;
  platform?: NodeJS.Platform;
  sea?: SeaRuntimeModule;
  storageRoot?: string;
}

const assetPrefix = "zcode-runtime-tools/";
const manifestAssetKey = `${assetPrefix}manifest.json`;
const markerFileName = ".nibi-runtime-tool.json";
const runtimeToolIds = new Set<RuntimeToolId>(["bfs", "ripgrep", "ugrep"]);

export async function ensureSeaRuntimeTools(
  options: EnsureSeaRuntimeToolsOptions = {},
): Promise<CliEnv> {
  const sea = options.sea ?? getSeaModule();
  if (!sea?.isSea()) return {};

  const platform = options.platform ?? process.platform;
  const target = runtimeTarget(platform, options.arch ?? process.arch);
  const manifest = readManifest(sea);
  if (manifest.target !== target) {
    throw new Error(
      `SEA runtime tool target mismatch: binary contains ${manifest.target}, runtime is ${target}.`,
    );
  }

  const env = options.env ?? process.env;
  const configuredStorageRoot = options.storageRoot ?? env.NIBI_STORAGE_DIR?.trim();
  const storageRoot = configuredStorageRoot || join(homedir(), ".nibi");
  const runtimeEnv: CliEnv = {};

  for (const tool of manifest.tools) {
    const runtime = getRuntimeToolRuntime(tool.id);
    if (env[runtime.binaryEnvVar]?.trim()) continue;

    runtimeEnv[runtime.binaryEnvVar] = await ensureRuntimeTool({
      manifest,
      sea,
      storageRoot,
      tool,
    });
  }

  return runtimeEnv;
}

async function ensureRuntimeTool(input: {
  manifest: SeaRuntimeToolManifest;
  sea: SeaRuntimeModule;
  storageRoot: string;
  tool: SeaRuntimeTool;
}): Promise<string> {
  const { manifest, sea, storageRoot, tool } = input;
  const cacheDirectory = join(
    storageRoot,
    "cache",
    "runtime_tools",
    manifest.target,
    tool.id,
    `${tool.version}-${tool.sha256}`,
  );
  const binaryPath = join(cacheDirectory, tool.binaryName);
  const marker = markerFor(manifest, tool);

  if (await isCacheCurrent(cacheDirectory, marker)) return binaryPath;

  const temporaryDirectory = `${cacheDirectory}.tmp-${process.pid}-${Date.now()}-${randomBytes(4).toString("hex")}`;
  await rm(temporaryDirectory, {
    force: true,
    recursive: true,
  });
  await mkdir(temporaryDirectory, {
    recursive: true,
  });

  try {
    const bytes = Buffer.from(sea.getRawAsset(assetKeyFor(tool)));
    if (bytes.byteLength !== tool.size) {
      throw new Error(`SEA runtime tool size mismatch for ${tool.id}.`);
    }
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== tool.sha256) {
      throw new Error(`SEA runtime tool hash mismatch for ${tool.id}.`);
    }

    const temporaryBinaryPath = join(temporaryDirectory, tool.binaryName);
    await writeFile(temporaryBinaryPath, bytes);
    await chmod(temporaryBinaryPath, 0o755);
    await writeFile(join(temporaryDirectory, markerFileName), JSON.stringify(marker, null, 2));

    await mkdir(dirname(cacheDirectory), {
      recursive: true,
    });
    if (await isCacheCurrent(cacheDirectory, marker)) return binaryPath;
    await installCacheDirectory(temporaryDirectory, cacheDirectory, marker);
    return binaryPath;
  } finally {
    await rm(temporaryDirectory, {
      force: true,
      recursive: true,
    });
  }
}

// 并发安装的收敛循环。
//
// POSIX 上 `rename` 覆盖非空目录会原子成功，两轮就够了；Windows 上同一操作会抛
// EPERM/EBUSY（另一个进程正把它的临时目录改名进来），必须"删旧目录再重试"。
// 实测 8 路并发时两轮预算会被打穿（`EPERM: ... rename`），所以：
//   1. 每轮先看缓存是否已是当前版本 —— 任一进程成功后其余立即收敛返回；
//   2. 竞态错误下清掉旧目录（清理本身也可能 EBUSY，同样容忍）后重试；
//   3. 预算内没收敛才抛最后一个错误，避免无限循环。
const INSTALL_CACHE_MAX_ATTEMPTS = 10;
const INSTALL_CACHE_RETRY_DELAY_MS = 5;

async function installCacheDirectory(
  temporaryDirectory: string,
  cacheDirectory: string,
  marker: RuntimeToolMarker,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < INSTALL_CACHE_MAX_ATTEMPTS; attempt += 1) {
    if (await isCacheCurrent(cacheDirectory, marker)) return;
    try {
      await rename(temporaryDirectory, cacheDirectory);
      return;
    } catch (error) {
      lastError = error;
      if (!isDirectoryReplaceRace(error)) throw error;
      try {
        await rm(cacheDirectory, {
          force: true,
          recursive: true,
        });
      } catch (removeError) {
        // 并发安装时另一个进程可能正把它的临时目录改名进同一路径，Windows 上会以
        // EBUSY/EPERM 拒绝删除（实测 `EBUSY: resource busy or locked, rmdir ...`）。
        // 这不是失败：只要最终缓存是当前版本就算装好，交给下一轮判定。
        if (!isDirectoryReplaceRace(removeError)) throw removeError;
      }
    }
    await delay(INSTALL_CACHE_RETRY_DELAY_MS * (attempt + 1));
  }

  // 收尾再确认一次：竞态下"最后一次失败"可能只是别的进程刚好赢了。
  if (await isCacheCurrent(cacheDirectory, marker)) return;
  throw lastError;
}

function delay(ms: number): Promise<void> {
  // 不能 unref：这是正在等待的安装流程的一部分，unref 会让"只剩这一个定时器"的
  // 进程直接退出（实测在独立复现脚本里表现为 unsettled top-level await）。
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readManifest(sea: SeaRuntimeModule): SeaRuntimeToolManifest {
  let manifest: SeaRuntimeToolManifest;
  try {
    manifest = JSON.parse(sea.getAsset(manifestAssetKey, "utf8")) as SeaRuntimeToolManifest;
  } catch (error) {
    throw new Error("Invalid SEA runtime tool manifest.", {
      cause: error,
    });
  }

  validateManifest(manifest);
  return manifest;
}

function validateManifest(manifest: SeaRuntimeToolManifest): void {
  if (
    manifest?.version !== 1 ||
    typeof manifest.target !== "string" ||
    !/^[a-z0-9]+-(?:arm64|x64)$/u.test(manifest.target) ||
    !Array.isArray(manifest.tools) ||
    manifest.tools.length === 0
  ) {
    throw new Error("Invalid SEA runtime tool manifest.");
  }

  const seenToolIds = new Set<RuntimeToolId>();
  for (const tool of manifest.tools) {
    if (
      !runtimeToolIds.has(tool?.id) ||
      seenToolIds.has(tool.id) ||
      typeof tool.binaryName !== "string" ||
      basename(tool.binaryName) !== tool.binaryName ||
      !/^[A-Za-z0-9._-]+$/u.test(tool.binaryName) ||
      !/^[a-f0-9]{64}$/u.test(tool.sha256) ||
      !Number.isSafeInteger(tool.size) ||
      tool.size < 0 ||
      typeof tool.version !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(tool.version)
    ) {
      throw new Error("Invalid SEA runtime tool manifest.");
    }
    seenToolIds.add(tool.id);
  }
}

// 可执行位（POSIX mode）只有 POSIX 宿主文件系统才保存；Windows 的 NTFS 不保存，
// chmod 0o755 后 `mode & 0o111` 仍是 0。凡是"检查可执行位"的地方都要按宿主判断，
// 不能按目标平台（目标平台决定文件名与发布物，不决定宿主能否表达 mode）。
function hostCarriesPosixModes(): boolean {
  return process.platform !== "win32";
}

async function isCacheCurrent(
  cacheDirectory: string,
  expected: RuntimeToolMarker,
): Promise<boolean> {
  try {
    const marker = JSON.parse(
      await readFile(join(cacheDirectory, markerFileName), "utf8"),
    ) as RuntimeToolMarker;
    if (
      marker.version !== expected.version ||
      marker.id !== expected.id ||
      marker.toolVersion !== expected.toolVersion ||
      marker.sha256 !== expected.sha256 ||
      marker.target !== expected.target ||
      marker.binaryName !== expected.binaryName ||
      marker.size !== expected.size
    ) {
      return false;
    }

    const binaryPath = join(cacheDirectory, expected.binaryName);
    const binaryStat = await stat(binaryPath);
    if (!binaryStat.isFile() || binaryStat.size !== expected.size) return false;
    // 可执行位是**宿主文件系统**的属性，与目标平台无关：Windows 的 NTFS 不保存 POSIX
    // mode（chmod 0o755 后 `mode & 0o111` 仍为 0）。原先按目标平台判断，于是
    // "Windows 宿主 + darwin 目标"永远判定缓存过期 → 每次调用都重新解包（实测缓存
    // 文件 inode 每次都变，命中该用例的 reuse 断言）。
    if (hostCarriesPosixModes() && (binaryStat.mode & 0o111) === 0) return false;

    const actualSha256 = createHash("sha256")
      .update(await readFile(binaryPath))
      .digest("hex");
    return actualSha256 === expected.sha256;
  } catch {
    return false;
  }
}

function markerFor(manifest: SeaRuntimeToolManifest, tool: SeaRuntimeTool): RuntimeToolMarker {
  return {
    binaryName: tool.binaryName,
    id: tool.id,
    sha256: tool.sha256,
    size: tool.size,
    target: manifest.target,
    toolVersion: tool.version,
    version: 1,
  };
}

function runtimeTarget(platform: NodeJS.Platform, arch: string): string {
  const releasePlatform = platform === "win32" ? "win" : platform;
  if (!["darwin", "linux", "win"].includes(releasePlatform) || !["arm64", "x64"].includes(arch)) {
    throw new Error(`Unsupported SEA runtime target ${platform}-${arch}.`);
  }
  return `${releasePlatform}-${arch}`;
}

function assetKeyFor(tool: SeaRuntimeTool): string {
  return `${assetPrefix}${tool.id}/${tool.sha256}/${tool.binaryName}`;
}

function getSeaModule(): SeaRuntimeModule | undefined {
  const getBuiltinModule = process.getBuiltinModule as
    | ((id: string) => SeaRuntimeModule | undefined)
    | undefined;
  try {
    return getBuiltinModule?.("node:sea");
  } catch {
    return undefined;
  }
}

function isDirectoryReplaceRace(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = String((error as NodeJS.ErrnoException).code);
  // Windows 上 `rename(src, dst)` 在 dst 是非空目录时抛 EPERM（POSIX 抛 ENOTEMPTY/EEXIST）；
  // 并发安装时删旧缓存还会遇到 EBUSY（另一进程正改名进来）。
  // 漏掉它们会让"清掉旧缓存再重命名"的重试永远不触发，直接失败（实测报
  // `EPERM: operation not permitted, rename ...` 与 `EBUSY: ... rmdir ...`）。
  return ["EEXIST", "ENOTEMPTY", "EPERM", "EBUSY"].includes(code);
}
