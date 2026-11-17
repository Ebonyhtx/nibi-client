#!/usr/bin/env node
/**
 * 判据：合并 ZCode-rs 上游代码时，两类「静默失配」必须挡住。
 *
 * 1) entry 前缀契约（R06）：Rust `node-store` 把 `Fact::Entry` 的 kind 写成
 *    `nibi-kernel/<kind>`，Node 的 `restart-entries.ts` 按同一前缀读。上游 0.1.88
 *    写的是 `rust-cli/<kind>`；如果有人整段搬上游实现，子代理恢复/权限模式/压缩边界
 *    会静默丢失——不报错，只是重启后读不到。
 *
 * 2) 安全依赖下限（R12）：0.1.88 的 lock 比 NIBI 已修的 CVE 版本旧
 *    （rusqlite 0.38 / rustls-webpki 0.103.15 / webpki-root-certs 1.0.9 /
 *    rustix 1.1.5 / libz-sys 1.1.30）。合并任何上游代码都必须保留 NIBI 的
 *    `kernel/Cargo.lock`，不能把这些版本带回去。
 *
 * 为什么用脚本而不是单测：这是跨语言契约（Rust 写、Node 读）与 workspace 级
 * lock 下限，放在 vitest 里只能覆盖一半；脚本可以同时读两侧源码与 lock。
 *
 * 用法：node scripts/check-kernel-upstream-gates.mjs [repoRoot]
 * 退出码：0 = 通过；1 = 有命中。
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(process.argv[2] ?? join(HERE, ".."));

const ENTRY_PREFIX = "nibi-kernel/";
const RUST_FACTS = "kernel/crates/node-store/src/facts.rs";
const NODE_READER = "apps/nibi-cli/packages/core/src/subagent/restart-entries.ts";
const RUST_NODE_STORE_SRC = "kernel/crates/node-store/src";
const CARGO_LOCK = "kernel/Cargo.lock";

/**
 * CVE 修复下限。只写「不能低于」，允许升级。
 * 版本号来自 NIBI 2026-10/11 的漏洞风暴修复线（见 nibi-oct2026-vuln-storm-audit）。
 */
const SECURITY_FLOOR = {
  rusqlite: "0.41.1",
  "libsqlite3-sys": "0.39.1",
  "webpki-root-certs": "1.0.11",
  "rustls-webpki": "0.103.16",
  rustix: "1.1.6",
  "libz-sys": "1.1.31",
};

const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function semverParts(version) {
  // 只处理 Cargo.lock 里的稳定版本（数字段 + 可选预发布）。
  const [core, prerelease] = version.split("-", 2);
  const numbers = core.split(".").map((part) => Number.parseInt(part, 10));
  return { numbers, prerelease: prerelease ?? "" };
}

function compareVersions(left, right) {
  const a = semverParts(left);
  const b = semverParts(right);
  const length = Math.max(a.numbers.length, b.numbers.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a.numbers[index] ?? 0) - (b.numbers[index] ?? 0);
    if (diff !== 0) return diff;
  }
  // 预发布版本低于同号正式版。
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  return a.prerelease.localeCompare(b.prerelease);
}

async function readText(relativePath) {
  try {
    return await readFile(join(REPO_ROOT, relativePath), "utf8");
  } catch (error) {
    fail(`读不到 ${relativePath}：${error.message}`);
    return "";
  }
}

async function checkEntryPrefix() {
  const facts = await readText(RUST_FACTS);
  const nodeReader = await readText(NODE_READER);

  const rustMatch = facts.match(/format!\("([^"{}]+)\/\{kind\}"\)/);
  const rustPrefix = rustMatch ? `${rustMatch[1]}/` : undefined;
  if (!rustPrefix) {
    fail(`${RUST_FACTS} 找不到 Fact::Entry 的 kind 前缀字面量（format!("<prefix>/{kind}")）`);
  } else if (rustPrefix !== ENTRY_PREFIX) {
    fail(`Rust entry 前缀是 ${JSON.stringify(rustPrefix)}，契约要求 ${JSON.stringify(ENTRY_PREFIX)}`);
  }

  const nodeMatch = nodeReader.match(/KERNEL_ENTRY_PREFIX\s*=\s*"([^"]+)"/);
  const nodePrefix = nodeMatch ? nodeMatch[1] : undefined;
  if (!nodePrefix) {
    fail(`${NODE_READER} 找不到 KERNEL_ENTRY_PREFIX`);
  } else if (nodePrefix !== ENTRY_PREFIX) {
    fail(`Node entry 前缀是 ${JSON.stringify(nodePrefix)}，契约要求 ${JSON.stringify(ENTRY_PREFIX)}`);
  }

  if (rustPrefix && nodePrefix && rustPrefix !== nodePrefix) {
    fail(`Rust 写 ${JSON.stringify(rustPrefix)}、Node 读 ${JSON.stringify(nodePrefix)}，重启恢复会静默失配`);
  }

  // 全 src 扫一遍：不允许出现上游 0.1.88 的 rust-cli/ 字符串字面量。
  const srcFiles = await readdir(join(REPO_ROOT, RUST_NODE_STORE_SRC));
  let nibiHits = 0;
  for (const file of srcFiles) {
    if (!file.endsWith(".rs")) continue;
    const text = await readText(join(RUST_NODE_STORE_SRC, file));
    nibiHits += (text.match(/"nibi-kernel\//g) ?? []).length;
    if (/"rust-cli\//.test(text)) {
      fail(`${RUST_NODE_STORE_SRC}/${file} 出现上游前缀 "rust-cli/"；NIBI 契约是 ${ENTRY_PREFIX}`);
    }
  }
  if (nibiHits === 0) {
    fail(`${RUST_NODE_STORE_SRC} 里没有任何 "nibi-kernel/" 字面量，判据没有真正比到东西`);
  }
  notes.push(`entry prefix: rust=${rustPrefix ?? "?"} node=${nodePrefix ?? "?"}（src 命中 ${nibiHits} 处）`);
}

async function checkSecurityLock() {
  const lock = await readText(CARGO_LOCK);
  if (!lock) return;

  const versions = new Map();
  for (const block of lock.split("[[package]]").slice(1)) {
    const name = block.match(/^name = "([^"]+)"/m)?.[1];
    const version = block.match(/^version = "([^"]+)"/m)?.[1];
    if (name && version) versions.set(name, version);
  }

  let compared = 0;
  for (const [name, floor] of Object.entries(SECURITY_FLOOR)) {
    const actual = versions.get(name);
    if (!actual) {
      fail(`${CARGO_LOCK} 缺少 ${name}，无法确认 CVE 修复线`);
      continue;
    }
    compared += 1;
    if (compareVersions(actual, floor) < 0) {
      fail(`${name} 被回退到 ${actual}，低于 NIBI 安全下限 ${floor}（合并上游代码必须保留 NIBI Cargo.lock）`);
    }
  }
  notes.push(`Cargo.lock 安全下限：比较 ${compared}/${Object.keys(SECURITY_FLOOR).length} 个包`);
}

await checkEntryPrefix();
await checkSecurityLock();

for (const note of notes) console.log(`[kernel-upstream-gates] ${note}`);
if (failures.length > 0) {
  for (const message of failures) console.error(`[kernel-upstream-gates] FAIL ${message}`);
  console.error(`[kernel-upstream-gates] ${failures.length} 条命中`);
  process.exit(1);
}
console.log("[kernel-upstream-gates] PASS");
