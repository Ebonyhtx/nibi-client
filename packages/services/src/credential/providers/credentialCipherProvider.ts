import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import { CREDENTIAL_DECRYPT_ERROR_CODE, CREDENTIAL_DECRYPT_ERROR_PREFIX } from "@nibi/shared";
import { loadOrCreateInstallKeySync, readInstallKeySync } from "@nibi/shared/node";

const ENCRYPTED_VALUE_PREFIX = "enc:v1:";
const ENCRYPTED_VALUE_PREFIX_V2 = "enc:v2:";
const CREDENTIAL_CIPHER_ALGORITHM = "aes-256-gcm";
const CREDENTIAL_CIPHER_IV_BYTES = 12;
const CREDENTIAL_CIPHER_AUTH_TAG_BYTES = 16;
const CREDENTIAL_SECRET_ENV_KEY = "NIBI_CREDENTIAL_SECRET";

export interface CredentialCipherProvider {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

interface CredentialCipherProviderOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * per-install 随机密钥文件路径（@nibi/shared/node credentialInstallKey）。
   * 提供后写入一律 `enc:v2:`；`enc:v1:` 旧值仍可解（迁移期读取）。
   * 缺省保持 v1 行为——仅限测试与尚未接线的调用方。
   */
  installKeyPath?: string;
}

function deriveCipherKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function defaultCredentialSecret(env: NodeJS.ProcessEnv): string {
  const configuredSecret = env[CREDENTIAL_SECRET_ENV_KEY];
  if (configuredSecret) {
    return configuredSecret;
  }

  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // 部分运行环境可能拿不到系统用户，失败时退回默认占位值。
  }

  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
}

function base64urlToBuffer(raw: string): Buffer {
  return Buffer.from(raw, "base64url");
}

function bufferToBase64url(raw: Buffer): string {
  return raw.toString("base64url");
}

function createCredentialDecryptError(
  reason: string,
): Error & { code: typeof CREDENTIAL_DECRYPT_ERROR_CODE } {
  return Object.assign(new Error(`${CREDENTIAL_DECRYPT_ERROR_PREFIX}${reason}`), {
    code: CREDENTIAL_DECRYPT_ERROR_CODE,
  });
}

/** v1（可推导 fallback 密钥）密文前缀；存储层用它挑出需要惰性迁移到 v2 的旧值。 */
export function isLegacyEncryptedCredentialValue(value: string): boolean {
  return value.startsWith(ENCRYPTED_VALUE_PREFIX);
}

export function createCredentialCipherProvider(
  options: CredentialCipherProviderOptions = {},
): CredentialCipherProvider {
  const env = options.env ?? process.env;
  const configuredSecret = env[CREDENTIAL_SECRET_ENV_KEY]?.trim();
  // 显式 env secret 时两代密钥相同：部署方自带高熵密钥，v1/v2 前缀都由它守护。
  const legacyKey = deriveCipherKey(configuredSecret ?? defaultCredentialSecret(env));
  const useInstallKey = options.installKeyPath !== undefined;
  // 解密侧只读不生成：新机器上没有钥匙文件时 v2 密文必须失败（fail-closed），
  // 否则"拷走 credentials.json"的攻击者等价于拿到了可用凭据。
  let cachedInstallKey: Buffer | null | undefined;

  const resolveInstallKeyForDecrypt = (): Buffer | null => {
    if (configuredSecret) return legacyKey;
    if (cachedInstallKey === undefined) {
      cachedInstallKey = readInstallKeySync(options.installKeyPath as string);
    }
    return cachedInstallKey;
  };
  const resolveInstallKeyForEncrypt = (): Buffer => {
    if (configuredSecret) return legacyKey;
    // 加密发生在写入路径；缺失则原子独占生成（并发进程读回同一把）。
    return loadOrCreateInstallKeySync(options.installKeyPath as string);
  };

  const decryptWithKey = (key: Buffer, payload: string): string => {
    const parts = payload.split(".");
    const [ivRaw, authTagRaw, cipherRaw] = parts;

    // Bug 根因：AES-GCM 加密空字符串时 cipherText 合法地为空，编码结果以点号结尾。
    // 旧判定把空 cipherRaw 当成缺字段，Provider Sync 为无 API Key 条目保存 journal 后
    // 就无法解密，连 before 回滚也会 fail-closed；这里只拒绝真正缺失的第三段。
    if (!ivRaw || !authTagRaw || cipherRaw === undefined || parts.length !== 3) {
      throw createCredentialDecryptError("密文格式非法");
    }

    const iv = base64urlToBuffer(ivRaw);
    const authTag = base64urlToBuffer(authTagRaw);
    const cipherText = base64urlToBuffer(cipherRaw);

    if (iv.length !== CREDENTIAL_CIPHER_IV_BYTES) {
      throw createCredentialDecryptError("IV 长度非法");
    }

    if (authTag.length !== CREDENTIAL_CIPHER_AUTH_TAG_BYTES) {
      throw createCredentialDecryptError("AuthTag 长度非法");
    }

    const decipher = createDecipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    try {
      const plainText = Buffer.concat([decipher.update(cipherText), decipher.final()]);
      return plainText.toString("utf-8");
    } catch {
      throw createCredentialDecryptError("密钥不匹配或密文已损坏");
    }
  };

  return {
    encrypt(value: string): string {
      const iv = randomBytes(CREDENTIAL_CIPHER_IV_BYTES);
      const key = useInstallKey || configuredSecret ? resolveInstallKeyForEncrypt() : legacyKey;
      const cipher = createCipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf-8"), cipher.final()]);
      const authTag = cipher.getAuthTag();
      const prefix =
        useInstallKey || configuredSecret ? ENCRYPTED_VALUE_PREFIX_V2 : ENCRYPTED_VALUE_PREFIX;

      return [
        prefix,
        bufferToBase64url(iv),
        ".",
        bufferToBase64url(authTag),
        ".",
        bufferToBase64url(encrypted),
      ].join("");
    },

    decrypt(value: string): string {
      if (value.startsWith(ENCRYPTED_VALUE_PREFIX_V2)) {
        if (!useInstallKey && !configuredSecret) {
          // 未接线的调用方（测试/旧读端）遇到 v2 密文：宁可报错也不当明文返回。
          throw createCredentialDecryptError("v2 密文需要 per-install 密钥");
        }
        const installKey = resolveInstallKeyForDecrypt();
        if (!installKey) {
          throw createCredentialDecryptError(
            "per-install 密钥缺失（凭据被复制到别的机器，或密钥文件被删除）",
          );
        }
        return decryptWithKey(installKey, value.slice(ENCRYPTED_VALUE_PREFIX_V2.length));
      }
      if (!value.startsWith(ENCRYPTED_VALUE_PREFIX)) {
        return value;
      }
      return decryptWithKey(legacyKey, value.slice(ENCRYPTED_VALUE_PREFIX.length));
    },
  };
}
