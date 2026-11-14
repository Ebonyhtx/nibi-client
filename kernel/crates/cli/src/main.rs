//! `nibi-rs` 可执行文件入口；真正的组装与命令行逻辑在 `lib.rs`（同一份代码也编成 cdylib）。
fn main() -> std::process::ExitCode {
    nibi::main_entry()
}
