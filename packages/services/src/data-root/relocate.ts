/**
 * 数据根迁移：按清单先复制到 `<目标>/.nibi/.migrating-<stamp>/` 暂存区，验证 v2 凭据可解密，
 * 再发布为正式的 `.nibi/machine`、`.nibi/v2` 与 `.nibi/workspace`。
 *
 * 不变量：
 * - `machine`（per-install 凭据密钥）永远不进入 `v2`；只拷走 v2 必须解不开凭据。
 * - 目标已有不同的安装密钥时拒绝迁移，源目录与 setting.json 都不变。
 * - 目标已有非空数据（v2/workspace）时只允许同一安装密钥的非覆盖合并。
 * - v2 的过滤规则（setting.json 及瞬时文件）不套用到 workspace；workspace 只跳过符号链接。
 * - 成功时 workspace 缺失是 no-op；失败时清理暂存区，下次重试幂等。
 */
import { constants as fsConstants, lstatSync } from "node:fs";
import { cp, copyFile, lstat, mkdir, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { resolveInstallKeyPathForCredentialsFile } from "@nibi/shared/node";
import { createCredentialCipherProvider } from "../credential/providers/credentialCipherProvider.js";
import { maybeThrowInjectedFsFault } from "../fs/fsFaultInjection.js";
import {
  DATA_ROOT_APP_DATA_DIR_NAME,
  DATA_ROOT_MACHINE_DIR_NAME,
  DATA_ROOT_MANIFEST,
  DATA_ROOT_STAGING_PREFIX,
  DATA_ROOT_WORKSPACE_DIR_NAME,
  getAppDataDirForBase,
  getMachineDirForBase,
  getManifestEntryDirForBase,
  getNibiRootDirForBase,
  getRelocationStagingDir,
} from "./manifest.js";

export const DATA_ROOT_RELOCATION_ERROR_CODES = {
  /** 目标已有 machine/credential-v2.key 且内容与源不同。 */
  keyConflict: "DATA_ROOT_RELOCATION_KEY_CONFLICT",
  /** 目标已有数据（v2 非空或结构冲突），拒绝覆盖。 */
  targetNotEmpty: "DATA_ROOT_RELOCATION_TARGET_NOT_EMPTY",
  /** 目标路径落在源数据目录内部（会递归复制）等非法目标。 */
  invalidTarget: "DATA_ROOT_RELOCATION_INVALID_TARGET",
  /** 暂存区凭据无法解密，迁移会让目标根变成不可用凭据。 */
  credentialVerificationFailed: "DATA_ROOT_RELOCATION_CREDENTIAL_VERIFY_FAILED",
} as const;

export type DataRootRelocationErrorCode =
  (typeof DATA_ROOT_RELOCATION_ERROR_CODES)[keyof typeof DATA_ROOT_RELOCATION_ERROR_CODES];

export class DataRootRelocationError extends Error {
  readonly code: DataRootRelocationErrorCode;

  constructor(code: DataRootRelocationErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "DataRootRelocationError";
    this.code = code;
  }
}

/** 目标安装密钥与源的关系；same/target-only 都续用目标文件，绝不覆盖。 */
export type TargetInstallKeyState = "absent" | "same" | "target-only";

/**
 * 凭据 / 密钥路径一律走 @nibi/shared/node 的同一份推导，避免把
 * `machine/credential-v2.key` 的布局在迁移代码里复制成第二个事实源。
 */
function getCredentialsFilePathForBase(baseDir: string): string {
  return join(getAppDataDirForBase(baseDir), "credentials.json");
}

function getInstallKeyPathForBase(baseDir: string): string {
  return resolveInstallKeyPathForCredentialsFile(getCredentialsFilePathForBase(baseDir));
}

/** 暂存区凭据验证结果；不含明文或密文内容。 */
export interface DataRootCredentialVerification {
  credentialsPresent: boolean;
  v1ValueCount: number;
  v2ValueCount: number;
  verifiedV1Key: string | null;
  verifiedV2Key: string | null;
  keySource: "install-key" | "env-secret" | "none";
  skipReason: "credentials-missing" | "no-encrypted-values" | "no-v2-values" | null;
}

export interface RelocateDataRootResult {
  fromBaseDir: string;
  toBaseDir: string;
  stagingDir: string;
  /** 是否复制了 `.nibi/v2`。 */
  copiedData: boolean;
  /** 是否复制了 `.nibi/workspace`；源没有该目录时为 false（no-op）。 */
  copiedWorkspace: boolean;
  copiedMachine: boolean;
  targetKeyState: TargetInstallKeyState;
  verification: DataRootCredentialVerification;
}

export interface VerifyStagedCredentialsOptions {
  env?: NodeJS.ProcessEnv;
}

/** 复制单个清单条目（第三参数是清单条目名，用于选择目录专属过滤规则）。 */
export type DataRootCopyTree = (
  sourcePath: string,
  destinationPath: string,
  entry: string,
) => Promise<void>;

export interface RelocateDataRootOptions {
  env?: NodeJS.ProcessEnv;
  /** 测试注入：替换目录树复制实现（默认 fs.cp + 按条目过滤 setting/软链）。 */
  copyTree?: DataRootCopyTree;
  /** 测试注入：替换暂存区凭据验证实现（默认 verifyStagedCredentials）。 */
  verifyCredentials?: (stagingDir: string) => Promise<DataRootCredentialVerification>;
  /** 测试注入：固定暂存目录名后缀。 */
  stagingStamp?: string;
}

const ENCRYPTED_VALUE_PREFIX_V1 = "enc:v1:";
const ENCRYPTED_VALUE_PREFIX_V2 = "enc:v2:";

/** 优先用登录/JWT/license 这类代表性密文验证；都没有时按 key 排序取第一条。 */
const REPRESENTATIVE_CREDENTIAL_KEYS = [
  "oauth:nibi:access_token",
  "nibi-jwttoken",
  "nibi:license:token",
] as const;

/** 本进程内正在使用的暂存目录；清理时不能误删并发迁移的现场。 */
const activeStagingDirectories = new Set<string>();

/** 串行化切根操作：同一进程内的暂存目录与发布步骤不并发。 */
let relocationTail: Promise<unknown> = Promise.resolve();

function withRelocationLock<T>(run: () => Promise<T>): Promise<T> {
  const next = relocationTail.then(run, run);
  relocationTail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

type PathKind = "missing" | "file" | "directory" | "other";

async function getPathKind(path: string): Promise<PathKind> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return "missing";
    throw error;
  }
  if (stats.isSymbolicLink()) return "other";
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((entry) => typeof entry === "string");
}

function pickRepresentativeEntry(
  entries: ReadonlyArray<readonly [string, string]>,
): readonly [string, string] | null {
  for (const preferredKey of REPRESENTATIVE_CREDENTIAL_KEYS) {
    const matched = entries.find(([key]) => key === preferredKey);
    if (matched) return matched;
  }
  return [...entries].sort(([left], [right]) => left.localeCompare(right))[0] ?? null;
}

function verificationError(message: string, cause: unknown): DataRootRelocationError {
  return new DataRootRelocationError(
    DATA_ROOT_RELOCATION_ERROR_CODES.credentialVerificationFailed,
    message,
    { cause },
  );
}

function createEmptyVerification(): DataRootCredentialVerification {
  return {
    credentialsPresent: false,
    v1ValueCount: 0,
    v2ValueCount: 0,
    verifiedV1Key: null,
    verifiedV2Key: null,
    keySource: "none",
    skipReason: "credentials-missing",
  };
}

/**
 * 用暂存区自己的 credentials.json 与 machine 密钥做真实解密。
 * 没有 v2 密文时跳过 v2 校验并在报告里说明，不阻断纯 v1/明文记录。
 */
export async function verifyStagedCredentials(
  stagingDir: string,
  options: VerifyStagedCredentialsOptions = {},
): Promise<DataRootCredentialVerification> {
  const env = options.env ?? process.env;
  // 凭据验证只针对 v2；workspace 是用户工作区，不包含 NIBI 凭据，也不参与验证。
  const credentialsPath = join(stagingDir, DATA_ROOT_APP_DATA_DIR_NAME, "credentials.json");
  const envSecretConfigured = Boolean(env.NIBI_CREDENTIAL_SECRET?.trim());

  let raw: string;
  try {
    // 故障注入点：读不到暂存凭据按"验证失败"处理，绝不发布未验证的数据。
    maybeThrowInjectedFsFault({ operation: "readFile", path: credentialsPath });
    raw = await readFile(credentialsPath, "utf-8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return createEmptyVerification();
    }
    throw verificationError(`无法读取暂存区凭据文件：${credentialsPath}`, error);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw verificationError(`暂存区 credentials.json 不是合法 JSON：${credentialsPath}`, error);
  }
  if (!isStringRecord(parsed)) {
    throw verificationError(`暂存区 credentials.json 结构非法：${credentialsPath}`, null);
  }

  const entries = Object.entries(parsed);
  const v1Entries = entries.filter(([, value]) => value.startsWith(ENCRYPTED_VALUE_PREFIX_V1));
  const v2Entries = entries.filter(([, value]) => value.startsWith(ENCRYPTED_VALUE_PREFIX_V2));

  let verifiedV1Key: string | null = null;
  if (v1Entries.length > 0) {
    const representative = pickRepresentativeEntry(v1Entries);
    const provider = createCredentialCipherProvider({ env });
    try {
      if (!representative) throw new Error("no representative v1 value");
      provider.decrypt(representative[1]);
      verifiedV1Key = representative[0];
    } catch (error) {
      throw verificationError(`暂存区 v1 凭据无法解密：${representative?.[0] ?? "unknown"}`, error);
    }
  }

  let verifiedV2Key: string | null = null;
  if (v2Entries.length > 0) {
    const representative = pickRepresentativeEntry(v2Entries);
    const provider = createCredentialCipherProvider({
      env,
      // 标准布局：v2/credentials.json 的钥匙在 v2 之外的 machine/ 下；
      // 用与运行时相同的推导，避免暂存区验证出一套"自己的"路径规则。
      installKeyPath: resolveInstallKeyPathForCredentialsFile(credentialsPath),
    });
    try {
      if (!representative) throw new Error("no representative v2 value");
      provider.decrypt(representative[1]);
      verifiedV2Key = representative[0];
    } catch (error) {
      throw verificationError(
        `暂存区 v2 凭据无法解密（密钥缺失或不匹配）：${representative?.[0] ?? "unknown"}`,
        error,
      );
    }
  }

  const skipReason =
    entries.length === 0
      ? "no-encrypted-values"
      : v1Entries.length === 0 && v2Entries.length === 0
        ? "no-encrypted-values"
        : v2Entries.length === 0
          ? "no-v2-values"
          : null;

  return {
    credentialsPresent: true,
    v1ValueCount: v1Entries.length,
    v2ValueCount: v2Entries.length,
    verifiedV1Key,
    verifiedV2Key,
    keySource: envSecretConfigured ? "env-secret" : v2Entries.length > 0 ? "install-key" : "none",
    skipReason,
  };
}

function isSymbolicLinkPath(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    // 扫描期间文件可能已消失（例如 setting.json.lock）；放行交给 cp 处理。
    return false;
  }
}

/**
 * v2 专属过滤：setting.json 是 bootstrap 指针，`setting.json.*` 是原子写入瞬时文件，
 * 都不随数据迁移；软链（例如 agent-config 里的共享技能目录）也不能复制。
 */
function shouldCopyV2TreeEntry(sourcePath: string): boolean {
  const sourceName = basename(sourcePath);
  if (sourceName === "setting.json" || sourceName.startsWith("setting.json.")) {
    return false;
  }
  return !isSymbolicLinkPath(sourcePath);
}

/**
 * workspace 里可再生的依赖/构建缓存目录：迁移时跳过，避免把 node_modules/venv 这类
 * 动辄数 GB、且切根后可以重装的内容整体复制。其它文件（包括用户自己的 setting.json）
 * 仍原样复制。
 */
const WORKSPACE_SKIPPED_DIR_NAMES = new Set([
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".cache",
  ".next",
  ".nuxt",
  "target",
]);

/**
 * workspace 专属过滤：跳过符号链接与依赖/构建缓存目录。用户工作区里名为 setting.json
 * 的普通文件属于用户数据，必须原样复制，不能套用 v2 的 bootstrap 指针规则。
 */
function shouldCopyWorkspaceTreeEntry(sourcePath: string): boolean {
  if (isSymbolicLinkPath(sourcePath)) {
    return false;
  }
  return !WORKSPACE_SKIPPED_DIR_NAMES.has(basename(sourcePath));
}

/** 按清单条目选择过滤规则；machine 沿用 v2 的软链过滤（其中不会有 setting.json）。 */
function createManifestEntryCopyFilter(entry: string): (sourcePath: string) => boolean {
  return entry === DATA_ROOT_WORKSPACE_DIR_NAME
    ? shouldCopyWorkspaceTreeEntry
    : shouldCopyV2TreeEntry;
}

async function defaultCopyTree(
  sourcePath: string,
  destinationPath: string,
  entry: string,
): Promise<void> {
  // 故障注入点：这里失败时暂存区还没有发布，setting 不会被改写。
  maybeThrowInjectedFsFault({ operation: "writeFile", path: destinationPath });
  await cp(sourcePath, destinationPath, {
    recursive: true,
    force: false,
    filter: createManifestEntryCopyFilter(entry),
  });
}

function createStagingStamp(): string {
  return `${Date.now()}-${process.pid}-${randomBytes(4).toString("hex")}`;
}

function createDataRootError(
  code: DataRootRelocationErrorCode,
  message: string,
  cause?: unknown,
): DataRootRelocationError {
  return new DataRootRelocationError(code, message, cause === undefined ? undefined : { cause });
}

function normalizeForPathComparison(pathValue: string): string {
  const resolved = resolve(pathValue);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameOrInsidePath(candidate: string, parent: string): boolean {
  const normalizedCandidate = normalizeForPathComparison(candidate);
  const normalizedParent = normalizeForPathComparison(parent);
  if (normalizedCandidate === normalizedParent) return true;
  const relativePath = relative(normalizedParent, normalizedCandidate);
  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

/** 目标不能落在源 v2/workspace/machine 内部，否则暂存目录会被复制进源数据、递归膨胀。 */
function assertTargetOutsideSourceData(fromBaseDir: string, toBaseDir: string): void {
  const sourceDirs = [...DATA_ROOT_MANIFEST.data, ...DATA_ROOT_MANIFEST.machine].map((entry) =>
    getManifestEntryDirForBase(fromBaseDir, entry),
  );
  for (const sourceDir of sourceDirs) {
    if (isSameOrInsidePath(toBaseDir, sourceDir)) {
      throw createDataRootError(
        DATA_ROOT_RELOCATION_ERROR_CODES.invalidTarget,
        `目标数据根不能位于源数据目录内部：${toBaseDir}`,
      );
    }
  }
}

type TargetDataDirState = "absent" | "empty" | "occupied";

/**
 * 按清单检查目标所有 data 条目（v2/workspace）。
 * 任一条目非空都算 occupied：非空目标不一定拒绝，同一安装密钥的旧根允许非覆盖合并
 * （setting 写失败重试、还原），异钥/无钥则在下面统一拒绝。
 */
async function inspectTargetDataDir(toBaseDir: string): Promise<TargetDataDirState> {
  let sawDirectory = false;
  let sawOccupied = false;
  for (const entry of DATA_ROOT_MANIFEST.data) {
    const targetDataDir = getManifestEntryDirForBase(toBaseDir, entry);
    const targetKind = await getPathKind(targetDataDir);
    if (targetKind === "missing") continue;
    if (targetKind !== "directory") {
      throw createDataRootError(
        DATA_ROOT_RELOCATION_ERROR_CODES.targetNotEmpty,
        `目标数据条目不是目录：${targetDataDir}`,
      );
    }
    sawDirectory = true;
    if ((await readdir(targetDataDir)).length > 0) {
      sawOccupied = true;
    }
  }
  if (sawOccupied) return "occupied";
  return sawDirectory ? "empty" : "absent";
}

/**
 * occupied 目标只放行"同一安装密钥"：异钥/无钥无法证明是同一安装，
 * 沿用已确认边界拒绝，避免把两套 NIBI 数据混在一起。
 */
function assertTargetDataDirStateAllowed(
  targetDataDirState: TargetDataDirState,
  targetKeyState: TargetInstallKeyState,
  toBaseDir: string,
): void {
  if (targetDataDirState !== "occupied") return;
  if (targetKeyState === "same") return;
  throw createDataRootError(
    DATA_ROOT_RELOCATION_ERROR_CODES.targetNotEmpty,
    `目标已有数据且无法证明为同一安装（安装密钥：${targetKeyState}），拒绝迁移：${getNibiRootDirForBase(toBaseDir)}`,
  );
}

async function inspectTargetInstallKey(
  fromBaseDir: string,
  toBaseDir: string,
): Promise<TargetInstallKeyState> {
  const targetKeyPath = getInstallKeyPathForBase(toBaseDir);
  const targetKind = await getPathKind(targetKeyPath);
  if (targetKind === "missing") return "absent";
  if (targetKind !== "file") {
    throw createDataRootError(
      DATA_ROOT_RELOCATION_ERROR_CODES.keyConflict,
      `目标安装密钥不是普通文件：${targetKeyPath}`,
    );
  }

  const sourceKeyPath = getInstallKeyPathForBase(fromBaseDir);
  const sourceKind = await getPathKind(sourceKeyPath);
  if (sourceKind === "missing") {
    // 源没有密钥时无法证明"相同"；保留目标密钥，后续 v2 解密验证会 fail-closed。
    return "target-only";
  }
  if (sourceKind !== "file") {
    throw createDataRootError(
      DATA_ROOT_RELOCATION_ERROR_CODES.keyConflict,
      `源安装密钥不是普通文件：${sourceKeyPath}`,
    );
  }

  const [sourceKey, targetKey] = await Promise.all([
    readFile(sourceKeyPath),
    readFile(targetKeyPath),
  ]);
  if (!sourceKey.equals(targetKey)) {
    throw createDataRootError(
      DATA_ROOT_RELOCATION_ERROR_CODES.keyConflict,
      `目标已存在不同的凭据安装密钥，拒绝迁移：${targetKeyPath}`,
    );
  }
  return "same";
}

async function copyManifestEntry(
  sourceBaseDir: string,
  stagingDir: string,
  entry: string,
  copyTree: DataRootCopyTree,
): Promise<boolean> {
  const sourcePath = getManifestEntryDirForBase(sourceBaseDir, entry);
  const sourceKind = await getPathKind(sourcePath);
  if (sourceKind === "missing") {
    // workspace 缺失是正常状态：新安装可能还没有非项目对话。
    return false;
  }
  if (sourceKind !== "directory") {
    if (entry === DATA_ROOT_WORKSPACE_DIR_NAME && isSymbolicLinkPath(sourcePath)) {
      // workspace 只跳过符号链接；顶层 workspace 本身是软链时同样 no-op。
      return false;
    }
    // 顶层 v2/machine 是软链或普通文件时不能静默跳过：那会把 setting 指到一个没有数据的根。
    throw new Error(`数据根迁移源条目不是目录：${sourcePath}`);
  }
  await copyTree(sourcePath, join(stagingDir, entry), entry);
  return true;
}

/** 目标 machine 已存在时逐文件合并：已有文件（尤其密钥）一律不覆盖。 */
async function mergeDirectoryWithoutOverwrite(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
    const sourcePath = join(sourceDir, entry.name);
    const targetPath = join(targetDir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await mergeDirectoryWithoutOverwrite(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile()) continue;

    const targetKind = await getPathKind(targetPath);
    if (targetKind === "file") continue;
    if (targetKind !== "missing") {
      throw createDataRootError(
        DATA_ROOT_RELOCATION_ERROR_CODES.targetNotEmpty,
        `目标密钥目录结构冲突：${targetPath}`,
      );
    }
    maybeThrowInjectedFsFault({ operation: "writeFile", path: targetPath });
    await copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL);
  }
}

async function publishMachineDir(stagingDir: string, toBaseDir: string): Promise<void> {
  const stagedMachineDir = join(stagingDir, DATA_ROOT_MANIFEST.machine[0]);
  if ((await getPathKind(stagedMachineDir)) !== "directory") return;

  const targetMachineDir = getMachineDirForBase(toBaseDir);
  const targetKind = await getPathKind(targetMachineDir);
  if (targetKind === "missing") {
    maybeThrowInjectedFsFault({ operation: "rename", path: targetMachineDir });
    // 先发布 machine 再发布 v2：任何时刻都不会出现"有 v2 无钥匙"的正式目录。
    await rename(stagedMachineDir, targetMachineDir);
    return;
  }
  if (targetKind !== "directory") {
    throw createDataRootError(
      DATA_ROOT_RELOCATION_ERROR_CODES.targetNotEmpty,
      `目标密钥目录不是目录：${targetMachineDir}`,
    );
  }
  await mergeDirectoryWithoutOverwrite(stagedMachineDir, targetMachineDir);
}

async function renameStagedDataDir(stagedDataDir: string, targetDataDir: string): Promise<void> {
  maybeThrowInjectedFsFault({ operation: "rename", path: targetDataDir });
  try {
    await rename(stagedDataDir, targetDataDir);
  } catch (error) {
    if (
      isErrnoCode(error, "EEXIST") ||
      isErrnoCode(error, "ENOTEMPTY") ||
      isErrnoCode(error, "EPERM")
    ) {
      throw createDataRootError(
        DATA_ROOT_RELOCATION_ERROR_CODES.targetNotEmpty,
        `无法发布暂存数据（目标可能已存在内容）：${targetDataDir}`,
        error,
      );
    }
    throw error;
  }
}

/**
 * 逐项发布 data 清单（v2、workspace）。每个条目独立判断目标状态：
 * - 缺失：直接 rename 发布；
 * - 空目录：先删空目录再 rename（Windows 不能 rename 到已存在目录）；
 * - 非空：同一安装密钥的旧根，逐文件非覆盖合并（force:false 只补源里新增的文件）。
 */
async function publishDataDirs(stagingDir: string, toBaseDir: string): Promise<void> {
  for (const entry of DATA_ROOT_MANIFEST.data) {
    await publishDataDirEntry(stagingDir, toBaseDir, entry);
  }
}

async function publishDataDirEntry(
  stagingDir: string,
  toBaseDir: string,
  entry: string,
): Promise<void> {
  const stagedDataDir = join(stagingDir, entry);
  if ((await getPathKind(stagedDataDir)) !== "directory") return;

  const targetDataDir = getManifestEntryDirForBase(toBaseDir, entry);
  const targetKind = await getPathKind(targetDataDir);
  if (targetKind === "missing") {
    await renameStagedDataDir(stagedDataDir, targetDataDir);
    return;
  }
  if (targetKind !== "directory") {
    throw createDataRootError(
      DATA_ROOT_RELOCATION_ERROR_CODES.targetNotEmpty,
      `目标数据条目不是目录：${targetDataDir}`,
    );
  }

  const targetEntries = await readdir(targetDataDir);
  if (targetEntries.length === 0) {
    // Windows 不能 rename 到已存在目录；空目录先删掉。
    maybeThrowInjectedFsFault({ operation: "rm", path: targetDataDir });
    await rmdir(targetDataDir);
    await renameStagedDataDir(stagedDataDir, targetDataDir);
    return;
  }

  // 同一安装密钥的旧根：逐文件非覆盖合并。
  // force:false 会跳过目标已有文件（老语义"还原不覆盖"），只把源里新增的文件补进去；
  // 每个条目使用自己的过滤规则（v2 排除 setting.json/瞬时文件，workspace 只跳过软链）。
  maybeThrowInjectedFsFault({ operation: "writeFile", path: targetDataDir });
  await cp(stagedDataDir, targetDataDir, {
    recursive: true,
    force: false,
    filter: createManifestEntryCopyFilter(entry),
  });
}

/**
 * 清理 `<base>/.nibi` 下的 `.migrating-*` 残留。
 * 本进程正在使用的暂存目录会跳过；跨进程并发迁移不在支持范围内。
 */
export async function cleanupStaleRelocationStaging(baseDir: string): Promise<number> {
  const nibiRootDir = getNibiRootDirForBase(baseDir);
  let entries;
  try {
    entries = await readdir(nibiRootDir, { withFileTypes: true });
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return 0;
    throw error;
  }

  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(DATA_ROOT_STAGING_PREFIX)) {
      continue;
    }
    const stagingDir = join(nibiRootDir, entry.name);
    if (activeStagingDirectories.has(stagingDir)) continue;
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    removed += 1;
  }
  return removed;
}

/**
 * 把数据根从 `fromBaseDir` 迁到 `toBaseDir`。
 *
 * 成功返回时正式目录已就位，但 setting.json 的写入由调用方负责；
 * 失败抛错；发布前失败不会留下正式 v2/workspace/machine 目录（暂存区 best-effort 清理），
 * 同一安装密钥下的重试按非覆盖合并保持幂等。
 */
export async function relocateDataRoot(
  fromBaseDir: string,
  toBaseDir: string,
  options: RelocateDataRootOptions = {},
): Promise<RelocateDataRootResult> {
  const from = resolve(fromBaseDir);
  const to = resolve(toBaseDir);

  if (normalizeForPathComparison(from) === normalizeForPathComparison(to)) {
    // 同一根：没有可复制的数据，也不需要发布。
    return {
      fromBaseDir: from,
      toBaseDir: to,
      stagingDir: "",
      copiedData: false,
      copiedWorkspace: false,
      copiedMachine: false,
      targetKeyState: "same",
      verification: createEmptyVerification(),
    };
  }
  assertTargetOutsideSourceData(from, to);

  return withRelocationLock(async () => {
    // 先清掉上次崩溃留下的暂存目录，再检查目标正式目录。
    await cleanupStaleRelocationStaging(to);
    const targetDataDirState = await inspectTargetDataDir(to);
    const targetKeyState = await inspectTargetInstallKey(from, to);
    assertTargetDataDirStateAllowed(targetDataDirState, targetKeyState, to);

    const stagingDir = getRelocationStagingDir(to, options.stagingStamp ?? createStagingStamp());
    activeStagingDirectories.add(stagingDir);
    try {
      maybeThrowInjectedFsFault({ operation: "mkdir", path: stagingDir });
      await mkdir(getNibiRootDirForBase(to), { recursive: true });
      await mkdir(stagingDir, { recursive: false });

      const copyTree = options.copyTree ?? defaultCopyTree;
      const copiedMachine = await copyManifestEntry(
        from,
        stagingDir,
        DATA_ROOT_MACHINE_DIR_NAME,
        copyTree,
      );
      // 按清单逐项复制 data：v2（App 数据）与 workspace（非项目对话工作区）。
      const copiedDataEntries = new Set<string>();
      for (const entry of DATA_ROOT_MANIFEST.data) {
        if (await copyManifestEntry(from, stagingDir, entry, copyTree)) {
          copiedDataEntries.add(entry);
        }
      }
      const copiedData = copiedDataEntries.has(DATA_ROOT_APP_DATA_DIR_NAME);
      const copiedWorkspace = copiedDataEntries.has(DATA_ROOT_WORKSPACE_DIR_NAME);

      // 凭据解密验证只读取暂存区 v2；workspace 不参与。
      const verification = options.verifyCredentials
        ? await options.verifyCredentials(stagingDir)
        : await verifyStagedCredentials(stagingDir, { env: options.env });

      // machine 先发布：不会出现"有 v2/workspace 无钥匙"的中间态。
      await publishMachineDir(stagingDir, to);
      await publishDataDirs(stagingDir, to);

      return {
        fromBaseDir: from,
        toBaseDir: to,
        stagingDir,
        copiedData,
        copiedWorkspace,
        copiedMachine,
        targetKeyState,
        verification,
      };
    } finally {
      activeStagingDirectories.delete(stagingDir);
      // 成功发布后暂存根可能只剩空壳（machine 已合并/改名）；失败时清理半成品。
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });
}
