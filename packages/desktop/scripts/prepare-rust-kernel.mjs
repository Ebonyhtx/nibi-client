#!/usr/bin/env node

// 把构建好的 Rust 内核二进制暂存进打包资源位次（`.staging/rust-kernel/nibi-rs[.exe]`），
// electron-builder 的 extraResources 按 `to: "rust-kernel"` 收进 `<resources>/rust-kernel/`
// ——桌面进程管理器的打包位次（zcodeAgentProcessManager.findRustAgentBinary 的
// `resourcesPath/rust-kernel`）按这个路径解析。Cargo 的 `[[bin]]` 名与打包位次同名
// （`nibi-rs`），进程列表/任务管理器里显示的是 NIBI。
//
// 纪律：**可选资产**。默认内核是 Rust，但正式包不携带内核也要能跑（运行时回落 node）——本机没构建过
// 内核（kernel/target 下两档都没有）时跳过并退出 0，不fail打包。构建产物选档：release 优先
// （打包要优化档），debug 兜底；`NIBI_RUST_KERNEL_BIN` 显式指文件时无视位次。

import process from "node:process";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const workspaceRoot = resolve(desktopRoot, "..", "..");
const executable = process.platform === "win32" ? "nibi-rs.exe" : "nibi-rs";
const stagingDir = resolve(workspaceRoot, ".staging", "rust-kernel");

const explicit = process.env.NIBI_RUST_KERNEL_BIN?.trim();
const candidates = explicit
  ? [resolve(explicit)]
  : ["release", "debug"].map((profile) =>
      resolve(workspaceRoot, "kernel", "target", profile, executable),
    );

const source = candidates.find((candidate) => existsSync(candidate));
if (source === undefined) {
  console.log(
    "[prepare-rust-kernel] no kernel binary found (kernel/target/{release,debug}); " +
      "skipping — the packaged app falls back to the node kernel at runtime",
  );
  process.exit(0);
}

// 内核自身版本必须等于产品版本：远端执行器的 npm 平台包按内核版本精确取包
// （`ssh_executor.rs` 的 `Wanted { version: super::VERSION }`）。版本不同源的二进制打进安装包后，
// 每次远端部署都会精确请求 404 再静默退 latest。本地 release 编译默认是 `0.1.<build-number>`，
// 要报告产品版本必须带 `NIBI_RELEASE_VERSION=<根 package.json 版本>` 重编（CI 两条打包链都这么做）。
const appVersion = JSON.parse(readFileSync(join(workspaceRoot, "package.json"), "utf8")).version;
let reported;
try {
  reported = /^nibi (\S+)/u.exec(
    execFileSync(source, ["--version"], { encoding: "utf8", timeout: 15_000 }),
  )?.[1];
} catch (error) {
  reported = undefined;
  console.warn(`[prepare-rust-kernel] cannot run ${source} --version: ${error.message}`);
}
if (reported !== appVersion) {
  const message =
    `[prepare-rust-kernel] the kernel reports ${reported ?? "nothing"} but the app is ${appVersion}; ` +
    `rebuild it with NIBI_RELEASE_VERSION=${appVersion} ` +
    "(cargo build --locked --release -p nibi-kernel-cli --bin nibi-rs)";
  if (process.env.NIBI_ENV === "production") {
    console.error(`${message} — refusing to package a mismatched kernel`);
    process.exit(1);
  }
  console.warn(`${message} — the packaged app would download the wrong executor version`);
} else {
  console.log(`[prepare-rust-kernel] ${source} reports ${reported}`);
}

mkdirSync(stagingDir, { recursive: true });
const target = join(stagingDir, executable);
copyFileSync(source, target);
const bytes = statSync(target).size;
console.log(`[prepare-rust-kernel] staged ${source} -> ${target} (${bytes} bytes)`);

// 分发合规：内嵌二进制必须带着许可证与第三方归属一起进包。
// - LICENSE：内核本体 Apache-2.0；
// - THIRD-PARTY-NOTICES.txt：`vendor/` 里 rg/bfs/ugrep 与 `vendor/copied/` 里复制代码的归属。
// 缺任何一份都 fail-closed —— 宁可打包失败，也不要发一个没有归属的二进制。
const licenseMaterials = [
  ["LICENSE", join(workspaceRoot, "kernel", "LICENSE")],
  ["THIRD-PARTY-NOTICES.txt", join(workspaceRoot, "kernel", "vendor", "THIRD-PARTY-NOTICES.txt")],
];
for (const [name, material] of licenseMaterials) {
  if (!existsSync(material)) {
    console.error(
      `[prepare-rust-kernel] missing ${material}; refusing to stage the kernel binary without its license material`,
    );
    process.exit(1);
  }
  const destination = join(stagingDir, name);
  copyFileSync(material, destination);
  console.log(
    `[prepare-rust-kernel] staged ${material} -> ${destination} (${statSync(destination).size} bytes)`,
  );
}
