// 随包 npm：桌面 agent 跑在 Electron Node 上，用户机器没装 Node 时，stdio MCP 的 npm/npx
// 回退到这里 stage 的 npm（规格：docs/design/v2/mcp-node-fallback.md）。
//
// 为什么下载 registry tarball 而不是加 pnpm 依赖：仓库用 node-linker=hoisted，npm 包的
// npm/npx bin 会被链接进根 node_modules/.bin，覆盖开发者自己的 npm（新 npm 还不支持仓库
// 锁定的 Node 小版本）。这里按固定版本 + registry sha512 下载并缓存，开发工具链不受影响。
//
// 离线回退：registry 不可达时（内网构建机、TLS 波动）可以复制当前运行 Node 自带的 npm。
// 这条路径没有 registry integrity 可校验，所以它会打印醒目的 warning，并在 staging 目录旁
// 写 `npm-stage.json`（source: "local-node", integrityVerified: false）；只有显式设置
// NIBI_BUNDLED_NPM_OFFLINE=1 时才跳过网络，避免 CI 在没注意的情况下长期使用本机 npm。
import { createHash, randomUUID } from "node:crypto";
import { accessSync, createReadStream } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import process from "node:process";
import { downloadPrebuiltArchive } from "../../../scripts/prebuilt-binary-download.mjs";
import { extractPrebuiltArchive } from "../../../scripts/prebuilt-binary-extract.mjs";

// engines.node 必须接受 Electron 自带的 Node；升级 Electron 时同步确认 npm 版本。
export const BUNDLED_NPM_VERSION = "12.2.0";
export const BUNDLED_NPM_INTEGRITY =
  "sha512-ZsJjKpTnlmSXOLLXiU1xDCzC4Wlok4IwZmh/aw2KUuXytU7q6qMv/cUT7MoeSf95Slwuw/lRXYefGzGCspHPNQ==";
/** 相对 glm 目录（nibi.cjs 所在目录）的位置；与 bootstrap mcp-node-fallback.ts 同一约定。 */
export const BUNDLED_NPM_STAGED_SEGMENTS = ["node-runtime", "npm"];
export const BUNDLED_NPM_STAGE_MARKER = "npm-stage.json";
const NPM_REGISTRY_TARBALL_BASE = "https://registry.npmjs.org/npm/-/";
const NPM_TARBALL_PACKAGE_DIR = "package";
const NPM_REQUIRED_ENTRIES = ["bin/npm-cli.js", "bin/npx-cli.js"];
// npm help 不受支持；去掉文档与 man 页省下约 3MB。
const EXCLUDED_TOP_LEVEL_ENTRIES = new Set(["docs", "man"]);
const SHA512_PREFIX = "sha512-";

export function bundledNpmTarballUrl(version) {
  return `${NPM_REGISTRY_TARBALL_BASE}npm-${version}.tgz`;
}

/** 当前运行 Node 自带的 npm 根目录（nvm/mise/官方安装包布局）；找不到时 undefined。 */
export function resolveLocalNodeNpmRoot(execPath = process.execPath) {
  const nodeDir = dirname(execPath);
  return [
    join(nodeDir, "..", "lib", "node_modules", "npm"),
    join(nodeDir, "node_modules", "npm"),
  ].find(isNpmRootSync);
}

function isNpmRootSync(root) {
  return NPM_REQUIRED_ENTRIES.every((entry) => {
    try {
      accessSync(join(root, ...entry.split("/")));
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * 校验并缓存 tarball，解包后拷进 `<glmDir>/node-runtime/npm`。返回 staging 结果。
 * download / extract 可注入，测试无需网络。
 *
 * 网络不可用时自动回退到本机 Node 自带 npm（见文件头）；`allowLocalFallback: false` 关闭回退，
 * `offline: true`（或 env NIBI_BUNDLED_NPM_OFFLINE=1）跳过下载直接复制本机 npm。
 */
export async function stageBundledNpm({
  allowLocalFallback = process.env.NIBI_BUNDLED_NPM_ALLOW_LOCAL !== "0",
  cacheDir,
  download = downloadPrebuiltArchive,
  extract = extractPrebuiltArchive,
  glmDir,
  integrity = BUNDLED_NPM_INTEGRITY,
  localNpmRoot,
  log = console.log,
  offline = process.env.NIBI_BUNDLED_NPM_OFFLINE === "1",
  version = BUNDLED_NPM_VERSION,
}) {
  const targetRoot = join(glmDir, ...BUNDLED_NPM_STAGED_SEGMENTS);

  if (offline) {
    log(
      `[bundled-npm] NIBI_BUNDLED_NPM_OFFLINE=1, copying local Node npm instead of npm@${version}`,
    );
  } else {
    try {
      const tarballPath = await ensureVerifiedTarball({ cacheDir, download, integrity, version });
      const workDir = await mkdtemp(join(tmpdir(), "nibi-bundled-npm-"));
      try {
        await extract({
          archiveExt: "tgz",
          archivePath: tarballPath,
          cwd: workDir,
          extractDir: workDir,
        });
        const packageRoot = join(workDir, NPM_TARBALL_PACKAGE_DIR);
        await assertNpmEntries(packageRoot);
        await replaceDirectory(packageRoot, targetRoot);
      } finally {
        await rm(workDir, { force: true, recursive: true });
      }
      const result = {
        integrityVerified: true,
        source: "registry",
        stagedRoot: targetRoot,
        version,
      };
      await writeStageMarker({ glmDir, ...result });
      return result;
    } catch (error) {
      if (!allowLocalFallback) throw error;
      log(
        `[bundled-npm] npm@${version} registry staging failed (${error instanceof Error ? error.message : String(error)}); falling back to the local Node npm without registry integrity`,
      );
    }
  }

  const localRoot = localNpmRoot ?? resolveLocalNodeNpmRoot();
  if (!localRoot || !(await isNpmRoot(localRoot))) {
    throw new Error(
      `[bundled-npm] cannot stage npm: registry download failed and no usable local Node npm was found (${localRoot ?? "not detected"})`,
    );
  }
  await replaceDirectory(localRoot, targetRoot);
  log(
    `[bundled-npm] WARNING: staged npm from local Node (${localRoot}); registry sha512 was NOT verified (expected npm@${version})`,
  );
  const result = {
    integrityVerified: false,
    source: "local-node",
    stagedRoot: targetRoot,
    version,
  };
  await writeStageMarker({ glmDir, ...result });
  return result;
}

async function ensureVerifiedTarball({ cacheDir, download, integrity, version }) {
  const tarballPath = join(cacheDir, `npm-${version}.tgz`);
  if (await isTarballValid(tarballPath, integrity)) return tarballPath;

  await mkdir(cacheDir, { recursive: true });
  const temporaryPath = `${tarballPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await download(bundledNpmTarballUrl(version), temporaryPath);
    if (!(await isTarballValid(temporaryPath, integrity))) {
      throw new Error(`[bundled-npm] sha512 mismatch for npm@${version}`);
    }
    await rename(temporaryPath, tarballPath);
    return tarballPath;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function replaceDirectory(packageRoot, targetRoot) {
  await rm(targetRoot, { force: true, recursive: true });
  await mkdir(dirname(targetRoot), { recursive: true });
  await cp(packageRoot, targetRoot, {
    filter: (sourcePath) => !isExcludedTopLevelEntry(packageRoot, sourcePath),
    recursive: true,
  });
}

async function writeStageMarker({ glmDir, integrityVerified, source, version }) {
  await mkdir(glmDir, { recursive: true });
  await writeFile(
    join(glmDir, BUNDLED_NPM_STAGE_MARKER),
    `${JSON.stringify(
      {
        integrityVerified,
        source,
        stagedPath: join(...BUNDLED_NPM_STAGED_SEGMENTS),
        version,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function isTarballValid(tarballPath, integrity) {
  try {
    return (await sha512Integrity(tarballPath)) === integrity;
  } catch {
    return false;
  }
}

function sha512Integrity(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha512");
    createReadStream(path)
      .on("error", rejectPromise)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolvePromise(`${SHA512_PREFIX}${hash.digest("base64")}`));
  });
}

async function assertNpmEntries(packageRoot) {
  for (const entry of NPM_REQUIRED_ENTRIES) {
    const entryPath = join(packageRoot, ...entry.split("/"));
    try {
      await access(entryPath);
    } catch (error) {
      throw new Error(`[bundled-npm] missing npm entry ${entry} in ${packageRoot}`, {
        cause: error,
      });
    }
  }
}

async function isNpmRoot(packageRoot) {
  try {
    await assertNpmEntries(packageRoot);
    return true;
  } catch {
    return false;
  }
}

function isExcludedTopLevelEntry(packageRoot, sourcePath) {
  const relativePath = relative(packageRoot, sourcePath);
  return !relativePath.includes(sep) && EXCLUDED_TOP_LEVEL_ENTRIES.has(basename(sourcePath));
}

/** 供测试直接读取 marker；staging 目录旁边的小文件，不进入 npm 包本体。 */
export async function readBundledNpmStageMarker(glmDir) {
  try {
    return JSON.parse(await readFile(join(glmDir, BUNDLED_NPM_STAGE_MARKER), "utf8"));
  } catch {
    return undefined;
  }
}
