//! NIBI v2 凭据信封（与 Node `credential-cipher.ts` / `credentialInstallKey.ts` 对齐）。
//!
//! 格式（逐字节）：
//!
//! ```text
//! enc:v2:<iv base64url>.<auth tag base64url>.<ciphertext base64url>
//! ```
//!
//! - AES-256-GCM，IV 12B，tag 16B，base64url 无填充；
//! - v2 密钥是每安装随机 32B，落在 `.nibi/machine/credential-v2.key`（base64url 文本）；
//! - `enc:v1:` 仍可读（旧 fallback 密钥 = sha256(`zcode-credential-fallback:<platform>:<home>:<username>`)）；
//! - 显式 `NIBI_CREDENTIAL_SECRET` 时两代都用 sha256(secret)，且不生成/读取钥匙文件；
//! - v2 解密 fail-closed：钥匙缺失/损坏/只拷走 credentials.json 都失败，绝不静默重铸；
//! - 写入侧 `wx` 独占创建，并发进程只有一个写成功，其余读回同一把钥匙。
//!
//! 本模块不读全局 env；调用方把 `NIBI_CREDENTIAL_SECRET` 通过闭包传入。

// 凭据与钥匙是几十字节的同步小文件 IO；付费插件发现门禁也是同步路径。
// 异步化/目录锁要等内核接线时再按 rust-cli-fs 的口径统一做，先在这里局部豁免。
#![expect(
    clippy::disallowed_methods,
    reason = "credential/key files are tiny synchronous IO on the sync gate path"
)]

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::aead::{AES_256_GCM, Aad, LessSafeKey, Nonce, UnboundKey};
use ring::rand::{SecureRandom, SystemRandom};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::paths::{ENV_CREDENTIAL_SECRET, install_key_path_for};

pub const PREFIX_V1: &str = "enc:v1:";
pub const PREFIX_V2: &str = "enc:v2:";
pub const KEY_BYTES: usize = 32;
pub const IV_BYTES: usize = 12;
pub const TAG_BYTES: usize = 16;

#[derive(Debug, Error)]
pub enum CredentialError {
    #[error(
        "credential decrypt failed: v2 ciphertext requires an install key or NIBI_CREDENTIAL_SECRET"
    )]
    MissingInstallKey,
    #[error("credential decrypt failed: legacy v1 key is unavailable")]
    MissingLegacyKey,
    #[error("credential encrypt failed: no v2 key source is configured")]
    MissingEncryptionKey,
    #[error("credential decrypt failed: invalid ciphertext format")]
    InvalidFormat,
    #[error("credential decrypt failed: invalid IV length")]
    InvalidIvLength,
    #[error("credential decrypt failed: invalid auth tag length")]
    InvalidTagLength,
    #[error("credential decrypt failed: key mismatch or corrupted ciphertext")]
    KeyMismatch,
    #[error("credential install key is missing: {0}")]
    InstallKeyMissing(PathBuf),
    #[error("credential install key is empty: {0}")]
    InstallKeyEmpty(PathBuf),
    #[error("credential install key has invalid length: {0}")]
    InstallKeyInvalid(PathBuf),
    #[error("credential install key read failed: {path}: {source}")]
    InstallKeyRead {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("credential install key write failed: {path}: {source}")]
    InstallKeyWrite {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("credential install key disappeared after create: {0}")]
    InstallKeyVanished(PathBuf),
    #[error("credential crypto failed: {0}")]
    Crypto(&'static str),
}

/// v2 写入/读取的密钥来源。
#[derive(Debug, Clone)]
enum KeySource {
    /// 每安装随机钥匙文件。
    InstallKey(PathBuf),
    /// 显式 32B（测试与调用方已解析好的 env secret）。
    Explicit([u8; 32]),
}

pub struct CredentialCipher {
    source: Option<KeySource>,
    /// v1 读取密钥；`None` 时 v1 解密失败（不猜）。
    legacy_v1_key: Option<[u8; 32]>,
    /// 显式 env secret 时两代同钥，且不触碰钥匙文件。
    secret_key: Option<[u8; 32]>,
}

impl CredentialCipher {
    /// 标准入口：有 `NIBI_CREDENTIAL_SECRET` 时用 sha256(secret)，否则用
    /// `credentials.json` 配套的 per-install 钥匙。
    pub fn from_env(credentials_path: &Path, get: impl Fn(&str) -> Option<String>) -> Self {
        let secret = get(ENV_CREDENTIAL_SECRET)
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        if let Some(secret) = secret {
            let key = sha256(secret.as_bytes());
            return Self {
                source: Some(KeySource::Explicit(key)),
                legacy_v1_key: Some(key),
                secret_key: Some(key),
            };
        }
        Self {
            source: Some(KeySource::InstallKey(install_key_path_for(
                credentials_path,
            ))),
            legacy_v1_key: None,
            secret_key: None,
        }
    }

    /// 只读路径入口（不猜 env）：显式给钥匙路径。
    pub fn with_install_key_path(install_key_path: impl Into<PathBuf>) -> Self {
        Self {
            source: Some(KeySource::InstallKey(install_key_path.into())),
            legacy_v1_key: None,
            secret_key: None,
        }
    }

    /// 测试/已解析密钥：不落钥匙文件。
    pub fn with_explicit_key(key: [u8; KEY_BYTES]) -> Self {
        Self {
            source: Some(KeySource::Explicit(key)),
            legacy_v1_key: Some(key),
            secret_key: Some(key),
        }
    }

    pub fn with_legacy_v1_key(mut self, key: [u8; KEY_BYTES]) -> Self {
        self.legacy_v1_key = Some(key);
        self
    }

    /// 只覆盖 v1 读取密钥（v2 仍走 per-install key）。
    pub fn with_legacy_v1_secret(self, secret: &str) -> Self {
        self.with_legacy_v1_key(sha256(secret.as_bytes()))
    }

    pub fn encrypt(&self, plaintext: &str) -> Result<String, CredentialError> {
        let mut iv = [0u8; IV_BYTES];
        SystemRandom::new()
            .fill(&mut iv)
            .map_err(|_| CredentialError::Crypto("random IV"))?;
        self.encrypt_with_iv(plaintext, iv)
    }

    pub fn encrypt_with_iv(
        &self,
        plaintext: &str,
        iv: [u8; IV_BYTES],
    ) -> Result<String, CredentialError> {
        let key = self.key_for_encrypt()?;
        let sealed = seal(&key, &iv, plaintext.as_bytes())?;
        Ok(format_value(PREFIX_V2, &iv, &sealed.1, &sealed.0))
    }

    pub fn decrypt(&self, value: &str) -> Result<String, CredentialError> {
        if let Some(payload) = value.strip_prefix(PREFIX_V2) {
            let key = self.key_for_decrypt()?;
            return decrypt_payload(&key, payload);
        }
        if let Some(payload) = value.strip_prefix(PREFIX_V1) {
            let key = self
                .legacy_v1_key
                .or(self.secret_key)
                .ok_or(CredentialError::MissingLegacyKey)?;
            return decrypt_payload(&key, payload);
        }
        Ok(value.to_owned())
    }

    /// v1 → v2 惰性迁移；非加密值原样返回。
    pub fn migrate_v1_to_v2(&self, value: &str) -> Result<String, CredentialError> {
        if value.starts_with(PREFIX_V1) {
            let plaintext = self.decrypt(value)?;
            return self.encrypt(&plaintext);
        }
        Ok(value.to_owned())
    }

    fn key_for_encrypt(&self) -> Result<[u8; KEY_BYTES], CredentialError> {
        match &self.source {
            Some(KeySource::Explicit(key)) => Ok(*key),
            Some(KeySource::InstallKey(path)) => load_or_create_install_key(path),
            None => Err(CredentialError::MissingEncryptionKey),
        }
    }

    fn key_for_decrypt(&self) -> Result<[u8; KEY_BYTES], CredentialError> {
        match &self.source {
            Some(KeySource::Explicit(key)) => Ok(*key),
            // 解密侧只读不生成：拷来的凭据在新机器上没有钥匙时必须失败。
            Some(KeySource::InstallKey(path)) => {
                read_install_key(path)?.ok_or(CredentialError::MissingInstallKey)
            }
            None => Err(CredentialError::MissingInstallKey),
        }
    }
}

pub fn is_encrypted_value(value: &str) -> bool {
    value.starts_with(PREFIX_V1) || value.starts_with(PREFIX_V2)
}

pub fn is_legacy_encrypted_value(value: &str) -> bool {
    value.starts_with(PREFIX_V1)
}

/// Node `resolveFallbackCredentialSecret()` 的逐字复刻：
/// `zcode-credential-fallback:<platform>:<homedir>:<username>`。
/// `platform` 用 Node 的取值（`win32`/`darwin`/`linux`）。
pub fn fallback_v1_secret(node_platform: &str, home: &Path, username: &str) -> String {
    format!(
        "zcode-credential-fallback:{node_platform}:{}:{username}",
        home.display()
    )
}

pub fn fallback_v1_key(node_platform: &str, home: &Path, username: &str) -> [u8; KEY_BYTES] {
    sha256(fallback_v1_secret(node_platform, home, username).as_bytes())
}

/// 只读；缺失返回 None（调用方 fail-closed），损坏/长度不对报错且绝不重写。
pub fn read_install_key(path: &Path) -> Result<Option<[u8; KEY_BYTES]>, CredentialError> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(source) => {
            return Err(CredentialError::InstallKeyRead {
                path: path.to_path_buf(),
                source,
            });
        }
    };
    decode_install_key(path, raw.trim())
}

/// 写入侧：缺失则 `wx` 独占创建；并发时其余进程读回同一把钥匙。
pub fn load_or_create_install_key(path: &Path) -> Result<[u8; KEY_BYTES], CredentialError> {
    if let Some(existing) = read_install_key(path)? {
        return Ok(existing);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|source| CredentialError::InstallKeyWrite {
            path: path.to_path_buf(),
            source,
        })?;
    }
    let mut generated = [0u8; KEY_BYTES];
    SystemRandom::new()
        .fill(&mut generated)
        .map_err(|_| CredentialError::Crypto("random install key"))?;
    let encoded = URL_SAFE_NO_PAD.encode(generated);
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => {
            restrict_permissions(&file);
            file.write_all(format!("{encoded}\n").as_bytes())
                .map_err(|source| CredentialError::InstallKeyWrite {
                    path: path.to_path_buf(),
                    source,
                })?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            // 另一个进程先写成功；下面统一读回。注意「create_new 成功 → 写入内容」之间有一个
            // 窗口：并发读回会看到空文件（POSIX 上实测会，Windows 的共享锁语义掩盖了它）——
            // 有界等待内容出现，窗口耗尽仍空才按 fail-closed 报错。
        }
        Err(source) => {
            return Err(CredentialError::InstallKeyWrite {
                path: path.to_path_buf(),
                source,
            });
        }
    }
    // CI 的 4 核 runner 上创建者线程可能被调度走数百毫秒；窗口给到 2s。正常路径第一次读就有
    // 内容，不会等；窗口耗尽仍空才 fail-closed。
    const CONTENT_WAIT_ATTEMPTS: usize = 200;
    const CONTENT_WAIT_INTERVAL_MS: u64 = 10;
    for attempt in 0..CONTENT_WAIT_ATTEMPTS {
        let read = read_install_key(path);
        match read {
            Ok(Some(key)) => return Ok(key),
            Ok(None) => return Err(CredentialError::InstallKeyVanished(path.to_path_buf())),
            // 空文件：创建者在写内容的路上，等一小拍再读。
            Err(CredentialError::InstallKeyEmpty(_)) if attempt + 1 < CONTENT_WAIT_ATTEMPTS => {
                std::thread::sleep(std::time::Duration::from_millis(CONTENT_WAIT_INTERVAL_MS));
            }
            Err(error) => return Err(error),
        }
    }
    Err(CredentialError::InstallKeyEmpty(path.to_path_buf()))
}

fn decode_install_key(path: &Path, raw: &str) -> Result<Option<[u8; KEY_BYTES]>, CredentialError> {
    if raw.is_empty() {
        return Err(CredentialError::InstallKeyEmpty(path.to_path_buf()));
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(raw)
        .map_err(|_| CredentialError::InstallKeyInvalid(path.to_path_buf()))?;
    let key: [u8; KEY_BYTES] = decoded
        .try_into()
        .map_err(|_| CredentialError::InstallKeyInvalid(path.to_path_buf()))?;
    Ok(Some(key))
}

#[cfg(unix)]
fn restrict_permissions(file: &std::fs::File) {
    use std::os::unix::fs::PermissionsExt;
    let _ = file.set_permissions(fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_file: &std::fs::File) {
    // Windows 的 ACL 由安装目录继承；Node 侧 mode 0o600 在 NTFS 上同样不生效。
}

fn seal(
    key: &[u8; KEY_BYTES],
    iv: &[u8; IV_BYTES],
    plaintext: &[u8],
) -> Result<(Vec<u8>, [u8; TAG_BYTES]), CredentialError> {
    let key = LessSafeKey::new(
        UnboundKey::new(&AES_256_GCM, key)
            .map_err(|_| CredentialError::Crypto("AES-256-GCM key"))?,
    );
    let mut in_out = plaintext.to_vec();
    let tag = key
        .seal_in_place_separate_tag(Nonce::assume_unique_for_key(*iv), Aad::empty(), &mut in_out)
        .map_err(|_| CredentialError::Crypto("seal"))?;
    let mut tag_bytes = [0u8; TAG_BYTES];
    tag_bytes.copy_from_slice(tag.as_ref());
    Ok((in_out, tag_bytes))
}

fn decrypt_payload(key: &[u8; KEY_BYTES], payload: &str) -> Result<String, CredentialError> {
    let parts: Vec<&str> = payload.split('.').collect();
    if parts.len() != 3 {
        return Err(CredentialError::InvalidFormat);
    }
    let iv = URL_SAFE_NO_PAD
        .decode(parts[0])
        .map_err(|_| CredentialError::InvalidFormat)?;
    if iv.len() != IV_BYTES {
        return Err(CredentialError::InvalidIvLength);
    }
    let tag = URL_SAFE_NO_PAD
        .decode(parts[1])
        .map_err(|_| CredentialError::InvalidFormat)?;
    if tag.len() != TAG_BYTES {
        return Err(CredentialError::InvalidTagLength);
    }
    let mut ciphertext = URL_SAFE_NO_PAD
        .decode(parts[2])
        .map_err(|_| CredentialError::InvalidFormat)?;
    ciphertext.extend_from_slice(&tag);
    let mut iv_bytes = [0u8; IV_BYTES];
    iv_bytes.copy_from_slice(&iv);
    let key = LessSafeKey::new(
        UnboundKey::new(&AES_256_GCM, key)
            .map_err(|_| CredentialError::Crypto("AES-256-GCM key"))?,
    );
    let plaintext = key
        .open_in_place(
            Nonce::assume_unique_for_key(iv_bytes),
            Aad::empty(),
            &mut ciphertext,
        )
        .map_err(|_| CredentialError::KeyMismatch)?;
    String::from_utf8(plaintext.to_vec()).map_err(|_| CredentialError::InvalidFormat)
}

fn format_value(
    prefix: &str,
    iv: &[u8; IV_BYTES],
    tag: &[u8; TAG_BYTES],
    ciphertext: &[u8],
) -> String {
    format!(
        "{prefix}{}.{}.{}",
        URL_SAFE_NO_PAD.encode(iv),
        URL_SAFE_NO_PAD.encode(tag),
        URL_SAFE_NO_PAD.encode(ciphertext)
    )
}

fn sha256(value: &[u8]) -> [u8; 32] {
    let digest = Sha256::digest(value);
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest);
    key
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    use std::thread;

    const PLAINTEXT: &str = "sk-fixture-国";
    const V2_GOLDEN: &str = "enc:v2:AQIDBAUGBwgJCgsM.BvlaWOS5hq9NzTOeoYdfQQ.3UWB-1kTV5gd2NXAeEc";
    const V1_GOLDEN: &str = "enc:v1:AQIDBAUGBwgJCgsM.Qxhn6gD89BXTmfHZacWjAA.TQUQ1GosLA_J7jTQA_E";
    const V1_SECRET: &str = "nibi-test-credential-secret";

    fn fixed_key() -> [u8; KEY_BYTES] {
        let mut key = [0u8; KEY_BYTES];
        for (index, byte) in key.iter_mut().enumerate() {
            *byte = u8::try_from(index + 1).unwrap();
        }
        key
    }

    fn fixed_iv() -> [u8; IV_BYTES] {
        let mut iv = [0u8; IV_BYTES];
        for (index, byte) in iv.iter_mut().enumerate() {
            *byte = u8::try_from(index + 1).unwrap();
        }
        iv
    }

    #[test]
    fn decrypts_node_v2_golden_vector() {
        let cipher = CredentialCipher::with_explicit_key(fixed_key());
        assert_eq!(cipher.decrypt(V2_GOLDEN).unwrap(), PLAINTEXT);
    }

    #[test]
    fn encrypts_byte_identical_v2_value_for_fixed_iv() {
        let cipher = CredentialCipher::with_explicit_key(fixed_key());
        assert_eq!(
            cipher.encrypt_with_iv(PLAINTEXT, fixed_iv()).unwrap(),
            V2_GOLDEN
        );
    }

    #[test]
    fn decrypts_node_v1_golden_vector_and_migrates() {
        let dir = tempfile::tempdir().unwrap();
        let cipher = CredentialCipher::with_install_key_path(dir.path().join("credential-v2.key"))
            .with_legacy_v1_secret(V1_SECRET);
        assert_eq!(cipher.decrypt(V1_GOLDEN).unwrap(), PLAINTEXT);
        let migrated = cipher.migrate_v1_to_v2(V1_GOLDEN).unwrap();
        assert!(migrated.starts_with(PREFIX_V2));
        assert_eq!(cipher.decrypt(&migrated).unwrap(), PLAINTEXT);
    }

    #[test]
    fn missing_install_key_fails_closed_and_is_not_created() {
        let dir = tempfile::tempdir().unwrap();
        let key_path = dir.path().join(".nibi/machine/credential-v2.key");
        let cipher = CredentialCipher::with_install_key_path(&key_path);
        assert!(matches!(
            cipher.decrypt(V2_GOLDEN).unwrap_err(),
            CredentialError::MissingInstallKey
        ));
        assert!(!key_path.exists(), "decrypt must never create a key file");
    }

    #[test]
    fn empty_or_invalid_key_file_is_an_error_and_is_not_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let key_path = dir.path().join("credential-v2.key");
        fs::write(&key_path, "\n").unwrap();
        let cipher = CredentialCipher::with_install_key_path(&key_path);
        assert!(matches!(
            cipher.encrypt(PLAINTEXT).unwrap_err(),
            CredentialError::InstallKeyEmpty(_)
        ));
        assert_eq!(fs::read_to_string(&key_path).unwrap(), "\n");

        fs::write(&key_path, "not-a-key").unwrap();
        assert!(matches!(
            cipher.encrypt(PLAINTEXT).unwrap_err(),
            CredentialError::InstallKeyInvalid(_)
        ));
        assert_eq!(fs::read_to_string(&key_path).unwrap(), "not-a-key");
    }

    #[test]
    fn load_or_create_is_atomic_across_threads() {
        let dir = tempfile::tempdir().unwrap();
        let key_path = dir.path().join("machine/credential-v2.key");
        let barrier = Arc::new(Barrier::new(8));
        // 必须先起满 8 个线程再 join：边起边 join 会让第一个线程在 barrier 上等不到其余线程。
        let mut handles = Vec::new();
        for _ in 0..8 {
            let key_path = key_path.clone();
            let barrier = barrier.clone();
            handles.push(thread::spawn(move || {
                barrier.wait();
                load_or_create_install_key(&key_path).unwrap()
            }));
        }
        let keys: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert!(keys.windows(2).all(|pair| pair[0] == pair[1]));
        assert_eq!(read_install_key(&key_path).unwrap(), Some(keys[0]));
    }

    #[test]
    fn env_secret_uses_v2_prefix_without_touching_the_key_file() {
        let dir = tempfile::tempdir().unwrap();
        let credentials = dir.path().join(".nibi/v2/credentials.json");
        let cipher = CredentialCipher::from_env(&credentials, |name| {
            (name == ENV_CREDENTIAL_SECRET).then(|| "fixture-secret".to_owned())
        });
        let encrypted = cipher.encrypt(PLAINTEXT).unwrap();
        assert!(encrypted.starts_with(PREFIX_V2));
        assert_eq!(cipher.decrypt(&encrypted).unwrap(), PLAINTEXT);
        assert!(!dir.path().join(".nibi/machine/credential-v2.key").exists());
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let cipher = CredentialCipher::with_explicit_key(fixed_key());
        let mut tampered = V2_GOLDEN.to_owned();
        let last = tampered.pop().unwrap();
        tampered.push(if last == 'A' { 'B' } else { 'A' });
        assert!(cipher.decrypt(&tampered).is_err());
    }

    #[test]
    fn plaintext_passes_through_unchanged() {
        let cipher = CredentialCipher::with_explicit_key(fixed_key());
        assert_eq!(cipher.decrypt("plain-value").unwrap(), "plain-value");
        assert_eq!(
            cipher.migrate_v1_to_v2("plain-value").unwrap(),
            "plain-value"
        );
    }

    #[test]
    fn fallback_secret_matches_node_shape() {
        let secret = fallback_v1_secret("win32", Path::new("C:/Users/ebony"), "ebony");
        assert_eq!(
            secret,
            "zcode-credential-fallback:win32:C:/Users/ebony:ebony"
        );
    }
}
