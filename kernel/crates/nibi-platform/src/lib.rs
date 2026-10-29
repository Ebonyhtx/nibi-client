//! NIBI 自有平台层（阶段 1 的第一块）。
//!
//! 与上游 `platform` 的分工：上游负责 z.ai/BigModel 账号、套餐与 OAuth；NIBI 4.0 已删除
//! 套餐线，凭据、路径、license 设备/账号绑定必须按 NIBI 的行为重写，不能直接复用上游实现。
//!
//! 本 crate 只放纯逻辑与本地 IO，不依赖 kernel-api，也不读全局 `process.env`（调用方注入），
//! 因此可以在没有 Electron、没有网络、没有真实 `~/.nibi` 的单测里跑全判定表。
//!
//! 当前范围（2026-10-29 第一段）：
//! - [`paths`]：`.nibi` 数据根、`NIBI_*` env、凭据/钥匙/会话库路径；
//! - [`credentials`]：`enc:v2:` 信封、每安装随机钥匙、v1 读取与惰性迁移、丢钥匙 fail-closed；
//! - [`license`]：Ed25519 验签 + `dev` 设备绑定 + `uid/sub` 账号绑定 + exp/72h/7d 判定；
//! - [`device_flow`]：Device Authorization Grant 的请求形状与响应解析；
//! - [`paid_plugin`]：付费插件发现层门禁的判定顺序与文案。
//!
//! 尚未实现（下一段）：Device Flow 的 HTTP 轮询循环、manifest/安装记录读取，
//! 以及把这些模块接进内核的登录/插件加载路径。

pub mod credentials;
pub mod device_flow;
pub mod license;
pub mod paid_plugin;
pub mod paths;
