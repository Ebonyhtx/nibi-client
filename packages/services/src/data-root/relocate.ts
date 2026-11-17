/**
 * 数据根迁移：先复制到 `<目标>/.nibi/.migrating-<stamp>/` 暂存区，验证凭据可解密，
 * 再原子发布为正式的 `.nibi/v2` 与 `.nibi/machine`。
 *
 * 不变量：
 * - `machine`（per-install 凭据密钥）永远不进入 `v2`；只拷走 v2 必须解不开凭据。
 * - 目标已有不同的安装密钥时拒绝迁移，源目录与 setting.json 都不变。
 * - 目标已有非空 v2 时拒绝覆盖；只接受"不存在"或"空目录"。
 * - 失败时清理暂存区；下次启动/迁移会再清一次崩溃残留。
 */
import { constants as fsConstants, lstatSync } from "node:fs";
import { cp, copyFile, lstat, mkdir, readFile, readdir, rename, rm, rmdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { resolveInstallKeyPathForCredentialsFile } from "@nibi/shared/node";
import { createCredentialCipherProvider } from "../credential/providers/credentialCipherProvider.js";
import { maybeThrowInjectedFsFault } from "../fs/fsFaultInjection.js";
import {
  DATA_ROOT_MANIFEST,
  DATA_ROOT_STAGING_PREFIX,
  getAppDataDirForBase,
  getMachineDirForBase,
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
  copiedData: boolean;
  copiedMachine: boolean;
  targetKeyState: TargetInstallKeyState;
  verification: DataRootCredentialVerification;
}

export interface VerifyStagedCredentialsOptions {
  env?: NodeJS.ProcessEnv;
}

export interface RelocateDataRootOptions {
  env?: NodeJS.ProcessEnv;
  /** 测试注入：替换目录树复制实现（默认 fs.cp + setting/软链过滤）。 */
  copyTree?: (sourcePath: string, destinationPath: string) => Promise<void>;
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
  const credentialsPath = join(stagingDir, DATA_ROOT_MANIFEST.data[0], "credentials.json");
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

/** 复制 v2 时跳过 bootstrap 指针及其原子写入瞬时文件，以及 Windows 下不可复制的软链。 */
function shouldCopyDataTreeEntry(sourcePath: string): boolean {
  const sourceName = basename(sourcePath);
  if (sourceName === "setting.json" || sourceName.startsWith("setting.json.")) {
    return false;
  }
  try {
    if (lstatSync(sourcePath).isSymbolicLink()) return false;
  } catch {
    // 扫描期间文件可能已消失（例如 setting.json.lock）；放行交给 cp 处理。
  }
  return true;
}

async function defaultCopyTree(sourcePath: string, destinationPath: string): Promise<void> {
  // 故障注入点：这里失败时暂存区还没有发布，setting 不会被改写。
  maybeThrowInjectedFsFault({ operation: "writeFile", path: destinationPath });
  await cp(sourcePath, destinationPath, {
    recursive: true,
    force: false,
    filter: shouldCopyDataTreeEntry,
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

/** 目标不能落在源 v2/machine 内部，否则暂存目录会被复制进源数据、递归膨胀。 */
function assertTargetOutsideSourceData(fromBaseDir: string, toBaseDir: string): void {
  for (const sourceDir of [getAppDataDirForBase(fromBaseDir), getMachineDirForBase(fromBaseDir)]) {
    if (isSameOrInsidePath(toBaseDir, sourceDir)) {
      throw createDataRootError(
        DATA_ROOT_RELOCATION_ERROR_CODES.invalidTarget,
        `目标数据根不能位于源数据目录内部：${toBaseDir}`,
      );
    }
  }
}

type TargetDataDirState = "absent" | "empty" | "occupied";

async function inspectTargetDataDir(toBaseDir: string): Promise<TargetDataDirState> {
  const targetDataDir = getAppDataDirForBase(toBaseDir);
  const targetKind = await getPathKind(targetDataDir);
  if (targetKind === "missing") return "absent";
  if (targetKind !== "directory") {
    throw createDataRootError(
      DATA_ROOT_RELOCATION_ERROR_CODES.targetNotEmpty,
      `目标数据目录不是目录：${targetDataDir}`,
    );
  }
  const entries = await readdir(targetDataDir);
  // 非空目标不一定拒绝：同一安装密钥的旧根允许非覆盖合并（setting 写失败重试、还原）。
  return entries.length === 0 ? "empty" : "occupied";
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
    `目标已有数据且无法证明为同一安装（安装密钥：${targetKeyState}），拒绝迁移：${getAppDataDirForBase(toBaseDir)}`,
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
  copyTree: (sourcePath: string, destinationPath: string) => Promise<void>,
): Promise<boolean> {
  const sourcePath = join(getNibiRootDirForBase(sourceBaseDir), entry);
  const sourceKind = await getPathKind(sourcePath);
  if (sourceKind === "missing") return false;
  if (sourceKind !== "directory") {
    // 顶层 v2/machine 是软链或普通文件时不能静默跳过：那会把 setting 指到一个没有数据的根。
    throw new Error(`数据根迁移源条目不是目录：${sourcePath}`);
  }
  await copyTree(sourcePath, join(stagingDir, entry));
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

async function publishDataDir(
  stagingDir: string,
  toBaseDir: string,
  targetDataDirState: TargetDataDirState,
): Promise<void> {
  const stagedDataDir = join(stagingDir, DATA_ROOT_MANIFEST.data[0]);
  if ((await getPathKind(stagedDataDir)) !== "directory") return;

  const targetDataDir = getAppDataDirForBase(toBaseDir);
  if (targetDataDirState === "occupied") {
    // 同一安装密钥的旧根：逐文件非覆盖合并。
    // force:false 会跳过目标已有文件（老语义"还原不覆盖"），只把源里新增的文件补进去；
    // setting.json 与软链沿用 shouldCopyDataTreeEntry 的过滤。
    maybeThrowInjectedFsFault({ operation: "writeFile", path: targetDataDir });
    await cp(stagedDataDir, targetDataDir, {
      recursive: true,
      force: false,
      filter: shouldCopyDataTreeEntry,
    });
    return;
  }

  if (targetDataDirState === "empty") {
    // Windows 不能 rename 到已存在目录；空目录先删掉。
    maybeThrowInjectedFsFault({ operation: "rm", path: targetDataDir });
    await rmdir(targetDataDir);
  }

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
 * 失败抛错且不会留下正式 v2/machine 半套目录（暂存区 best-effort 清理）。
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
      const copiedData = await copyManifestEntry(
        from,
        stagingDir,
        DATA_ROOT_MANIFEST.data[0],
        copyTree,
      );
      const copiedMachine = await copyManifestEntry(
        from,
        stagingDir,
        DATA_ROOT_MANIFEST.machine[0],
        copyTree,
      );

      const verification = options.verifyCredentials
        ? await options.verifyCredentials(stagingDir)
        : await verifyStagedCredentials(stagingDir, { env: options.env });

      // machine 先发布：不会出现"v2 已就位但钥匙没搬过去"的中间态。
      await publishMachineDir(stagingDir, to);
      await publishDataDir(stagingDir, to, targetDataDirState);

      return {
        fromBaseDir: from,
        toBaseDir: to,
        stagingDir,
        copiedData,
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
