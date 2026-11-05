#!/usr/bin/env node

// 把构建好的 Rust 内核二进制暂存进打包资源位次（`.staging/rust-kernel/<packaged>`），
// electron-builder 的 extraResources 按 `to: "rust-kernel"` 收进 `<resources>/rust-kernel/`
// ——桌面进程管理器的打包位次（zcodeAgentProcessManager.findRustAgentBinary 的
// `resourcesPath/rust-kernel`）按这个路径解析。Cargo 的产物仍叫 `zcode-rs`（[[bin]] 名），
// 打包位次统一改名成 `nibi-rs`，进程列表/任务管理器里显示的是 NIBI。
//
// 灰度纪律：**可选资产**。`NIBI_KERNEL` 默认 node，正式包不携带内核也要能跑——本机没构建过
// 内核（kernel/target 下两档都没有）时跳过并退出 0，不fail打包。构建产物选档：release 优先
// （打包要优化档），debug 兜底；`NIBI_RUST_KERNEL_BIN` 显式指文件时无视位次。

import process from "node:process";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const workspaceRoot = resolve(desktopRoot, "..", "..");
const sourceExecutable = process.platform === "win32" ? "zcode-rs.exe" : "zcode-rs";
const packagedExecutable = process.platform === "win32" ? "nibi-rs.exe" : "nibi-rs";
const stagingDir = resolve(workspaceRoot, ".staging", "rust-kernel");

const explicit = process.env.NIBI_RUST_KERNEL_BIN?.trim();
const candidates = explicit
  ? [resolve(explicit)]
  : ["release", "debug"].map((profile) =>
      resolve(workspaceRoot, "kernel", "target", profile, sourceExecutable),
    );

const source = candidates.find((candidate) => existsSync(candidate));
if (source === undefined) {
  console.log(
    "[prepare-rust-kernel] no kernel binary found (kernel/target/{release,debug}); " +
      "skipping — the packaged app stays on the node kernel (NIBI_KERNEL=rust falls back at runtime)",
  );
  process.exit(0);
}

mkdirSync(stagingDir, { recursive: true });
// 暂存目录里只留打包名字：旧一次打包留下的 zcode-rs 会被 extraResources 整个目录收进包，
// 既多一份体积，也可能让用户看见两个内核文件。
const legacy = join(stagingDir, sourceExecutable);
if (legacy !== join(stagingDir, packagedExecutable)) {
  rmSync(legacy, { force: true });
}
const target = join(stagingDir, packagedExecutable);
copyFileSync(source, target);
const bytes = statSync(target).size;
console.log(`[prepare-rust-kernel] staged ${source} -> ${target} (${bytes} bytes)`);
