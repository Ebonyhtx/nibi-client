//! 记忆（docs/specs/rust-cli/memory.md）。
//!
//! 自动记忆目录（[`project_memory_root`]）、`MEMORY.md` 索引的截断
//! （[`entrypoint`]）。目录在本机存储里，由入口经 `nibi-kernel-fs` 创建，本 crate 不做 IO。
//!
//! `MEMORY.md` 的注入由 context 负责，回合结束后的抽取由 runtime 的 `memory` 模块负责；
//! 本 crate 只定义目录与索引截断。相关记忆召回、整理、子代理记忆仍待补（memory.md §1）。

pub mod entrypoint;
mod root;

pub use root::{project_memory_root, project_memory_root_for};
