# Rust 内核阶段 1 第一段：vendoring + 安全门禁 + 平台层（2026-10-29）

> 范围：只做 Step 1 的可验收部分，不切默认、不改 Node 回退、不做品牌化改名。
> 基线：NIBI-Client `4725ab6`；ZCode-rs `6d349ed4`（0.1.67，build 67）。

## 1. Vendoring

- 上游 `packages/rust-cli` 经 `git subtree split`（分支 `nibi-kernel-vendor`，split commit `e0965b46`）引入到 `NIBI-Client/kernel/`，squash 合并。
- `kernel/` 是独立 Cargo workspace（36 个上游 crate + 新增 `nibi-platform`），不依赖仓库内其他 TS 包。
- Apache-2.0 合规：`kernel/LICENSE`、`kernel/NOTICE.md` 自上游仓库根复制；`kernel/vendor/THIRD-PARTY-NOTICES.txt`（rg 15.2.0 / bfs 4.1.4 / ugrep 7.8.4）随子树保留。
- `kernel/CHANGELOG-FORK.md` 记录 pin、npm 产物校验、vendored 版本、门禁复跑与后续处置。

### npm 产物核验（预检 A）

| 项 | 结果 |
|---|---|
| `@mbearo/zcode@0.1.67` 主包 integrity | `sha512-oxCElsqdr+tUUTtMpUdHndKxmqy5+zXIjrII65ZMC6LXVk+ABVuyyd7OFZeS4IMoBDqJEb1kjgHGk46PRR4D9A==`，本地 sha512 一致 |
| `@mbearo/zcode-win32-x64@0.1.67` integrity | `sha512-q9MJce7y0DerO2C6qmhv5TFK1JQ+iRcbwvuXIDhkfUPTyjexsSsRdukj27B0B6Kr6RGLDcoGNCoXu+n40H5y2A==`，一致 |
| 平台包 `build.json` | `version=0.1.67`、`sourceCommit=6d349ed4…`、`target=x86_64-pc-windows-msvc` |
| 二进制 sha256 | `5f4e8880…`，与 `build.json` 一致 |
| `zcode.exe --version` | `zcode 0.1.67 (rust-cli)` |

## 2. 安全门禁（FIX-10b）

| 项 | 结果 |
|---|---|
| `webpki-root-certs` | **1.0.9 → 1.0.11**（`Cargo.lock:3879-3881`） |
| `rustls-webpki` | 0.103.15 → **0.103.16**（RUSTSEC-2026-0382，emSign 中间证书撤信） |
| `pulldown-cmark` | 0.13.4 → **0.13.5**（wikilink 解析漏洞；TUI-only） |
| `libz-sys` | 1.1.30 → **1.1.31**（构建期 env 探测；vendored ugrep） |
| `deny.toml` | 已落库；advisories / bans / licenses / sources **全绿** |
| `cargo audit` | **0 漏洞**；1 allowed warning（bincode unmaintained，TUI-only，已登记豁免） |
| `cargo check --locked --workspace` | **全绿**（首次 61s，共享 target 增量） |

## 3. 会话库互认（阶段 1 首项功能任务）

用 Node HEAD 的无头运行在隔离 HOME 下现场生成 `db.sqlite`，再用 Rust `node-store` 冷开：

```bash
NIBI_INTEROP_DB=<run>/home/.nibi/cli/db/db.sqlite \
NIBI_INTEROP_HOME=<run>/home \
cargo test -p rust-cli-node-store --test nibi_interop -- --nocapture
```

结果：**通过**。Rust 列出并 `load` 了 Node 写入的会话；冷开前后迁移账本不变。

0020–0024 SQL 三方比对（`scripts/kernel-baseline/compare-migration-sql.ts`）：

```text
0020-0024 SQL 逐字节比对：OK
  20: identical=true checksumDb=true bytes=18780
  21: identical=true checksumDb=true bytes=1955
  22: identical=true checksumDb=true bytes=4225
  23: identical=true checksumDb=true bytes=108
  24: identical=true checksumDb=true bytes=183
```

R2（迁移 SQL 正文未逐字节比对）**已关闭**。

## 4. nibi-platform 第一段

新增 `kernel/crates/nibi-platform`（不修改上游 `platform`，避免品牌化与功能 PR 混批）：

| 模块 | 内容 | 验证 |
|---|---|---|
| `paths` | `.nibi` 数据根、`NIBI_DATA_BASE_DIR`/`NIBI_STORAGE_DIR`/`NIBI_SETTINGS_DIR`、凭据/钥匙/会话库/CLI 配置路径、`nibi-agent` 名 | 默认布局、双根独立、`~` 展开、非标准凭据路径 |
| `credentials` | `enc:v2:` 信封、每安装 32B 随机钥匙（`wx` 独占创建）、v1 读取与惰性迁移、丢钥匙 fail-closed、`NIBI_CREDENTIAL_SECRET` 分支、损坏钥匙不重写 | Node 生成的 v1/v2 金标准密文逐字节对拍；并发 8 线程同钥；篡改/缺钥/空钥/坏钥 |
| `license` | Ed25519 验签（kid 查表、`EdDSA`/`Ed25519`）、`dev` 设备绑定、`uid/sub` 账号绑定、`exp` 硬边界、72h 检查 + 7 天宽限、refusal 映射 | Node 生成的 JWT 金标准；设备/账号不匹配、过期、宽限、refusal、篡改、缺 kid |
| `device_flow` | RFC 8628 端点/表单/响应解析、`authorization_pending`/`slow_down`/`expired_token`/`access_denied` | 请求形状、字段缺失、interval 下限、token 过期时间、userinfo |
| `paid_plugin` | 发现层判定顺序（refusal → token → 验签 → 设备 → exp → 插件覆盖）与用户文案 | 付费/未付费、缺 token、坏 token、设备不匹配、过期、未覆盖、refusal |

测试：`cargo test -p nibi-platform` **46 passed**；`cargo clippy -p nibi-platform --all-targets -- -D warnings` 通过；`cargo fmt --all -- --check` 通过。

尚未接线（属阶段 2）：Device Flow 的 HTTP 轮询循环、manifest/安装记录读取、把平台层接进内核登录/插件加载路径。

## 5. 与计划的偏差（必须知道）

1. **FIX-4 未执行**：`mise.toml`/`.nvmrc`/CLI engines/CI 仍为 24.14.0，Server CLI 仍 22.16.0。按计划 FIX-4 应先于 vendoring；本次 vendoring 只新增 `kernel/`，没有改 FIX-4 的八个钉定点，因此 FIX-4 后续可独立落地，不会与 `kernel/` 变基冲突。
2. **FIX-3/FIX-5/FIX-6 未执行**：本机 Node 24.19.0、Electron 41.0.3；FIX-6 需要改生产 Zitadel，本轮明确禁止。
3. **FIX-10a 未执行**：`.github/workflows/rust-gates.yml` 尚未新增；本轮只落了 `deny.toml` 和本地门禁实跑。
4. **品牌化未开始**：`kernel/` 仍是上游 ZCode 品牌；按计划等所有功能 track 完成后再做 §4.11/§7.7 收口。
5. **`cargo check` 而非 `cargo test --workspace`**：上游全量测试 3,600 属性，本轮只跑了新 crate 与 node-store 互认；全量测试留到阶段 2 前。

## 6. 复跑命令

```bash
cd kernel
cargo check --locked --workspace
cargo test -p nibi-platform
cargo deny check
cargo audit
cargo tree -i webpki-root-certs --locked   # 期望 1.0.11

cd ..
pnpm exec tsx scripts/kernel-baseline/compare-migration-sql.ts \
  --db <node-run>/home/.nibi/cli/db/db.sqlite
```
