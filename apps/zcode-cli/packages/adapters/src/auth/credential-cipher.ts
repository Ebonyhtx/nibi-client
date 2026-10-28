import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { homedir, platform, userInfo } from "node:os";
import { loadOrCreateInstallKeySync, readInstallKeySync } from "@nibi/shared/node";

const ENCRYPTED_VALUE_PREFIX = "enc:v1:";
const ENCRYPTED_VALUE_PREFIX_V2 = "enc:v2:";
const CREDENTIAL_CIPHER_ALGORITHM = "aes-256-gcm";
const CREDENTIAL_CIPHER_IV_BYTES = 12;
const CREDENTIAL_CIPHER_AUTH_TAG_BYTES = 16;
const CREDENTIAL_SECRET_ENV_KEY = "NIBI_CREDENTIAL_SECRET";

export interface ZCodeCredentialCipher {
  decrypt(value: string): string;
  encrypt(value: string): string;
}

export interface ZCodeCredentialCipherOptions {
  env?: Record<string, string | undefined>;
  /**
   * per-install 随机密钥文件路径（见 @nibi/shared/node 的 credentialInstallKey）。
   * 提供后写入一律用 `enc:v2:`（per-install 密钥）；`enc:v1:` 旧值仍可解（迁移期读取）。
   * 未提供时保持 v1 行为（可推导 fallback 密钥）——仅限测试与尚未接线的调用方。
   */
  installKeyPath?: string;
}

export function createZCodeCredentialCipher(
  options: ZCodeCredentialCipherOptions = {},
): ZCodeCredentialCipher {
  const env = options.env ?? process.env;
  const configuredSecret = env[CREDENTIAL_SECRET_ENV_KEY]?.trim();
  // 显式 env secret 时两代密钥相同：部署方自带高熵密钥，v1/v2 前缀都由它守护。
  const legacyKey = deriveCipherKey(configuredSecret ?? resolveFallbackCredentialSecret());
  const useInstallKey = options.installKeyPath !== undefined;
  // 解密侧只读不生成：拷来的凭据文件在新机器上没有钥匙文件时，v2 密文必须失败而不是静默重铸。
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

  const decryptWithKey = (key: Buffer, payloadParts: string[]): string => {
    const [ivRaw, authTagRaw, cipherRaw] = payloadParts;
    if (!ivRaw || !authTagRaw || !cipherRaw || payloadParts.length !== 3) {
      throw new Error("Credential decrypt failed: invalid ciphertext format");
    }
    const iv = Buffer.from(ivRaw, "base64url");
    const authTag = Buffer.from(authTagRaw, "base64url");
    const cipherText = Buffer.from(cipherRaw, "base64url");
    if (iv.length !== CREDENTIAL_CIPHER_IV_BYTES) {
      throw new Error("Credential decrypt failed: invalid IV length");
    }
    if (authTag.length !== CREDENTIAL_CIPHER_AUTH_TAG_BYTES) {
      throw new Error("Credential decrypt failed: invalid auth tag length");
    }
    try {
      const decipher = createDecipheriv(CREDENTIAL_CIPHER_ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      const plainText = Buffer.concat([decipher.update(cipherText), decipher.final()]);
      return plainText.toString("utf-8");
    } catch (error) {
      throw new Error("Credential decrypt failed: key mismatch or corrupted ciphertext", {
        cause: error,
      });
    }
  };

  return {
    decrypt(value: string): string {
      if (value.startsWith(ENCRYPTED_VALUE_PREFIX_V2)) {
        if (!useInstallKey && !configuredSecret) {
          // 未接线的调用方（测试/旧读端）遇到 v2 密文：宁可报错也不当明文返回。
          throw new Error("Credential decrypt failed: v2 ciphertext requires installKeyPath");
        }
        const installKey = resolveInstallKeyForDecrypt();
        if (!installKey) {
          throw new Error(
            "Credential decrypt failed: per-install key file is missing (credentials were copied or the install key was removed)",
          );
        }
        return decryptWithKey(installKey, value.slice(ENCRYPTED_VALUE_PREFIX_V2.length).split("."));
      }
      if (!isEncryptedZCodeCredentialValue(value)) {
        return value;
      }
      return decryptWithKey(legacyKey, value.slice(ENCRYPTED_VALUE_PREFIX.length).split("."));
    },

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
        iv.toString("base64url"),
        ".",
        authTag.toString("base64url"),
        ".",
        encrypted.toString("base64url"),
      ].join("");
    },
  };
}

export function isEncryptedZCodeCredentialValue(value: string): boolean {
  return (
    value.startsWith(ENCRYPTED_VALUE_PREFIX) || value.startsWith(ENCRYPTED_VALUE_PREFIX_V2)
  );
}

export function isLegacyEncryptedZCodeCredentialValue(value: string): boolean {
  return value.startsWith(ENCRYPTED_VALUE_PREFIX);
}

function deriveCipherKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function resolveFallbackCredentialSecret(): string {
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    // Some packaged or sandboxed runtimes cannot resolve OS user info.
  }

  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
}
