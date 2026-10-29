# NIBI 内核 fork 日志

> 纪律来源：《NIBI-Rust内核改造调研与规划》§4.7（五条纪律）与《NIBI-大改造与安全修复与品牌化执行计划》Step 5。
> 本文件随 `kernel/` 一起维护；每次重 pin、吸收/拒绝上游变更、新增 NIBI 自有迁移、复跑安全门禁都要追加记录。

## 1. Vendoring 基线

| 项 | 值 |
|---|---|
| 上游仓库 | `https://github.com/MBearo/ZCode-rs` |
| 参考克隆 | `D:\ZCODE-RUST\ZCode-rs`（工作树 detached） |
| pin commit | `6d349ed4c4cf31e05079056c08e6bea495544116`（0.1.67，build 67） |
| npm 发布 | `@mbearo/zcode@0.1.67`，2026-10-29T13:11:41Z |
| 主包 integrity | `sha512-oxCElsqdr+tUUTtMpUdHndKxmqy5+zXIjrII65ZMC6LXVk+ABVuyyd7OFZeS4IMoBDqJEb1kjgHGk46PRR4D9A==`（本地 npm pack 逐字节校验通过） |
| win32-x64 平台包 integrity | `sha512-q9MJce7y0DerO2C6qmhv5TFK1JQ+iRcbwvuXIDhkfUPTyjexsSsRdukj27B0B6Kr6RGLDcoGNCoXu+n40H5y2A==`（通过） |
| 平台包 `build.json` | `version=0.1.67`、`sourceCommit=6d349ed4…`、`target=x86_64-pc-windows-msvc`、`sha256=5f4e8880…`；`zcode.exe --version` = `0.1.67 (rust-cli)` |
| subtree 来源 | upstream 仓内 `git subtree split --prefix=packages/rust-cli 6d349ed4`，split 分支 `nibi-kernel-vendor` = `e0965b46b36c0470f1633ec54f70a7ab0dc421ab` |
| vendored 路径 | `NIBI-Client/kernel/`（workspace 根 = 上游 `packages/rust-cli`） |
| 许可证 | Apache-2.0；`kernel/LICENSE`、`kernel/NOTICE.md` 自上游仓库根复制；`kernel/vendor/THIRD-PARTY-NOTICES.txt` 随子树传递 |

## 2. vendored 二进制台账

来自上游 `vendor/THIRD-PARTY-NOTICES.txt`（随子树保留）：

| 组件 | 版本 |
|---|---|
| ripgrep (rg) | 15.2.0 |
| bfs | 4.1.4 |
| ugrep | 7.8.4 |

## 3. 安全门禁（FIX-10b）

| 项 | 状态 | 证据 |
|---|---|---|
| `webpki-root-certs` 下限 ≥1.0.11 | **已抬到 1.0.11** | `cargo update -p webpki-root-certs --precise 1.0.11`；`Cargo.lock:3879-3881`；`cargo tree -i webpki-root-certs --locked` 显示 1.0.11 |
| `rustls-webpki`（RUSTSEC-2026-0382） | **0.103.15 → 0.103.16** | 该版本拒收含已泄露 emSign 中间公钥的证书路径；比根证书包更靠内的一层 |
| `pulldown-cmark`（RUSTSEC-2026-0381 系列） | **0.13.4 → 0.13.5** | wikilink 解析漏洞；仅 TUI 依赖 |
| `libz-sys`（RUSTSEC-2026-0403） | **1.1.30 → 1.1.31** | 构建期环境变量探测；仅 vendored ugrep |
| `deny.toml` 落库 | **已落库** | `kernel/deny.toml` |
| `cargo deny check` | **全绿**（advisories/bans/licenses/sources ok） | 2026-10-29 实跑；`pulldown-cmark` 0.13.4→0.13.5、`rustls-webpki` 0.103.15→0.103.16、`libz-sys` 1.1.30→1.1.31；`bincode` unmaintained（RUSTSEC-2025-0141）按 TUI-only 豁免并登记在 `deny.toml` |
| `cargo audit` | **0 漏洞**（1 allowed warning：bincode unmaintained） | `cargo audit` 2026-10-29 实跑，扫描 415 个依赖 |

> 上游 0.1.67 基线为 1.0.9（2026-07-18，早于 eMudhra 事件），且 `crates/net/src/egress.rs` 使用 `Anchors::Merge` 合并平台信任库；不抬版本会把已撤根的旧锚重新信任回来。

## 3.1 会话库互认实测（2026-10-29）

- Rust `node-store` 冷开 NIBI Node 内核现场生成的隔离库：`cargo test -p rust-cli-node-store --test nibi_interop` 通过（列出并 `load` 了 Node 会话；账本冷开前后不变）。
- `0020–0024` 三方逐字节比对：Node `SQLITE_MIGRATIONS` / Rust `00NN_*.sql` / 库内 `schema_migration.checksum` 全部一致（`scripts/kernel-baseline/compare-migration-sql.ts`）。
- `cargo check --locked --workspace` 全绿（首次 61s，共享 target 增量）。

## 4. NIBI 自有迁移

当前 **无**。会话库迁移账本保持上游 `0001–0024`；建设期不新增 `0025+`（Rust 规划 §4.7 纪律 3）。若未来新增，必须在本节登记 id、SQL 摘要、checksum 与 Node 侧同步情况。

## 5. 上游变更吸收/拒绝记录

| 日期 | 上游变更 | 处置 | 理由 |
|---|---|---|---|
| 2026-10-29 | 0.1.66 → 0.1.67（130 文件 +8,605/−1,300） | 整体 pin；未逐项改造 | npm 产物可验证、编译全绿；协议/迁移/目标表/信任根/审计门禁零变化；F111–F114 是 NIBI 要继承的消费域修复 |
| 2026-10-30 | `schema/inbound.json` 的 commands/CAS 段与 `workspace/updateOffPeakToolPolicy` 方法；`server.rs` 的 offPeak 处理器 | **删除** | NIBI 已删 offPeak；命令契约改由 `nibi_commands`（NIBI zod 生成物）承接，上游 35 个命令（含 NIBI 不存在的 `setHighspeedMetrics`）不再进入校验路径 |

## 6. Step 2 第一切片（2026-10-30）

- NIBI 34 个 `CommandType` 契约进入协议前端：`schema/nibi-commands.json`（由 NIBI zod 生成，
  `scripts/kernel-baseline/generate-nibi-command-schema.ts --check` 守漂移）+ `src/nibi_commands.rs`。
- 上游 `schema/inbound.json` 删除整段 `commands`/CAS 与 `workspace/updateOffPeakToolPolicy` 方法；
  `server.rs` 删除 offPeak 处理器；`inbound.rs::command` 委托 NIBI 契约；`commands.rs::create_session`
  对内核未消费字段点名 `warn`（R12/R23 防静默丢失）。详见 `docs/rust-kernel-step2-slice1-2026-10-30.md`。
- 验证：protocol-zcode 25 测试（7 个契约测试）、clippy -D warnings、rust 1.95.0 MSRV、
  workspace check / nibi-platform / 互认 / deny / audit 全绿。
- 同日追加 4 个处理器：`switchModelConfig`（CAS→SetModel）、`switchCollaborationMode`
  （CAS→SetMode/SetPlan）、`compact`（→Compact）、`renameSession`（→Rename）；CAS 抽成
  `cas_check`（stale→`proto.staleRevision`），set_followup 同步改用。测试 25→28。
- 第三小批：`cancelBackgroundWork`（→StopTask；kernel 拒绝文案按关键词归到
  `fault.command.backgroundWorkCancelRejected.<code>`，`unknown` 兜底，TODO 等 kernel
  回执带机器可读 reason）；`createSession.config` 的扁平 provider/model/thought 作
  选择回落，未消费清单 11→6 项。测试仍 28。
- 第四小批：epoch CAS（`cas_check_with_epoch`，`proto.staleLogEpoch` 与 Node 同词）；
  `forkAssistant`（→`Command::Fork`，ACK result 带 `{type, sessionId}`）与
  `applyFileRewind`（→`Command::Rewind{scope: Code}`）两个 row-targeting 处理器，
  target 经 projection 行解析（entityId 匹配 + assistantResponseId 结算检查）。
  `Envelope` 补 `baseLogEpoch`；测试 28→29。

## 7. 未完成项

- `crates/nibi-platform` 已落地第一段：`paths`、`credentials`（v2/v1/env/钥匙文件）、`license`（Ed25519+dev/uid 绑定+exp/72h/7d）、`device_flow`（请求形状/响应解析）、`paid_plugin`（发现层判定）；46 个单测全绿。
- 尚未接线：Device Flow 的 HTTP 轮询循环、manifest/安装记录读取、把 `nibi-platform` 接进内核登录/插件加载路径（属阶段 2）。
- 品牌化未开始（本阶段只做 vendoring 与安全门禁，避免和功能 PR 混批）。
- 品牌化：本子树仍是上游 ZCode 品牌；按计划等所有功能 track 完成后再做 §4.11/§7.7 收口，本阶段只做 `kernel/` 引入与安全门禁。
