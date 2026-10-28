import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * 每台安装一份的随机凭据加密密钥（v2 cipher 的密钥来源）。
 *
 * 为什么不用 Electron safeStorage：这份凭据文件由桌面 host 与纯 Node agent/CLI 共享，
 * safeStorage 的密文只有 Electron 进程能解。改为"随机 per-install 密钥文件"：
 * 不可从 platform/home/username 推导（旧 fallback 密钥的洞——复制 credentials.json 到
 * 同配置机器即可解密），且文件放在 `.nibi/machine/` 下——只拷走 credentials.json
 * （甚至整个 v2/ 目录）在新机器上无法解出 v2 密文，fail-closed。
 */

const INSTALL_KEY_BYTE_LENGTH = 32;

/** credentials.json → 配套密钥文件路径。标准布局把钥匙放在 v2 目录之外。 */
export function resolveInstallKeyPathForCredentialsFile(credentialsFilePath: string): string {
  const dir = dirname(credentialsFilePath);
  if (basename(dir) === "v2") {
    return join(dirname(dir), "machine", "credential-v2.key");
  }
  return join(dir, "credential-v2.key");
}

/**
 * 只读：密钥缺失返回 null（v2 解密端 fail-closed）；损坏/长度不对抛错，
 * 绝不重新生成覆盖——那会让已有 v2 密文永久不可解。
 */
export function readInstallKeySync(keyPath: string): Buffer | null {
  let raw: string;
  try {
    raw = readFileSync(keyPath, "utf8").trim();
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw new Error(`Unable to read credential install key: ${keyPath}`, { cause: error });
  }
  if (!raw) {
    throw new Error(`Credential install key file is empty: ${keyPath}`);
  }
  const key = Buffer.from(raw, "base64url");
  if (key.length !== INSTALL_KEY_BYTE_LENGTH) {
    throw new Error(`Credential install key has invalid length: ${keyPath}`);
  }
  return key;
}

/**
 * 写入侧专用：缺失则生成。用 `wx` 独占创建保证并发进程（host 与 agent 同时首次写入）
 * 只有一个写成功，其余读回同一把钥匙；两侧不同钥会互相解不开凭据。
 */
export function loadOrCreateInstallKeySync(keyPath: string): Buffer {
  const existing = readInstallKeySync(keyPath);
  if (existing) return existing;
  mkdirSync(dirname(keyPath), { recursive: true });
  const generated = randomBytes(INSTALL_KEY_BYTE_LENGTH).toString("base64url");
  try {
    writeFileSync(keyPath, `${generated}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!isAlreadyExistsError(error)) throw error;
  }
  const key = readInstallKeySync(keyPath);
  if (!key) {
    throw new Error(`Credential install key disappeared after create: ${keyPath}`);
  }
  return key;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST"
  );
}
