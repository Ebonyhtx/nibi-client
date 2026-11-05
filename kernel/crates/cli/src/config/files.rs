//! 项目级配置文件的发现（2026-10-30 下沉到 `rust_cli_hooks::project_config`）。
//!
//! 保留同名模块与再导出，`config` 里的调用点（`discover` / `ProjectFile` / `relative`）不变；
//! 下沉的原因：钩子评审的协议面在 runtime 与 protocol-nibi，拿不到 CLI 二进制里的实现。

pub(crate) use rust_cli_hooks::project_config::{discover, relative, ProjectFile};
#[cfg(test)]
pub(crate) use rust_cli_hooks::project_config::project_file;
