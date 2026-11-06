#!/usr/bin/env node
/**
 * 判据：会话库里消息行的 `agent` 值，Node 与 Rust 必须写同一个字面量。
 *
 * 为什么单列一条：这是**跨语言的数据契约**，两边各写各的常量，没有任何编译器或类型能
 * 把它们连起来。实测踩过：改 Rust 的 `records::AGENT` 却漏了 Node 的
 * `agentName ?? "zcode-agent"`（散在 10 个持久化方法里），结果是同一个会话在两种内核下
 * 写出不同的 `agent` 值——而当时逐条测试全是绿的，因为读侧对未知值宽容。
 *
 * 判据两件事：
 * 1. Node 侧不得再写上游名（`agent: "zcode-agent"` / `agentName ?? "zcode-agent"`）；
 * 2. Node 的缺省值与 Rust 的 `AGENT` 常量逐字相同。
 *
 * 用法：node scripts/check-session-agent-identity.mjs
 * 退出码：0 = 一致；1 = 分叉或有残留。
 */
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(process.argv[2] ?? join(HERE, ".."));

/** Node 侧写 `agent` 的地方（持久化方法）。列成目录而不是硬编码文件：新加持久化方法要自动纳入。 */
const NODE_METHOD_DIRS = [
  "apps/zcode-cli/packages/core/src/runtime/methods",
  "apps/zcode-cli/packages/bootstrap/src/nibi-protocol",
];
const RUST_RECORDS = "kernel/crates/node-store/src/records.rs";

/** `agent: this.config.agentName ?? "x"` / `agent: runtime.config.agentName ?? "x"` / `agent: "x"`. */
const NODE_DEFAULT = /\bagent:\s*(?:[A-Za-z_$.]*config\.agentName\s*\?\?\s*)?"([^"]+)"/g;
const RUST_AGENT = /pub const AGENT: &str = "([^"]+)";/;

async function listSources(dir) {
  const full = join(REPO_ROOT, dir);
  const entries = await readdir(full, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name))
    .map((entry) => join(dir, entry.name));
}

const violations = [];
const defaults = new Set();
let scanned = 0;

for (const dir of NODE_METHOD_DIRS) {
  for (const file of await listSources(dir)) {
    const text = await readFile(join(REPO_ROOT, file), "utf8");
    for (const [index, line] of text.split("\n").entries()) {
      if (/^\s*(\/\/|\*)/.test(line)) continue;
      NODE_DEFAULT.lastIndex = 0;
      for (const match of line.matchAll(NODE_DEFAULT)) {
        scanned += 1;
        defaults.add(match[1]);
        if (/^z(code|ai)/i.test(match[1])) {
          violations.push({ file, line: index + 1, value: match[1], text: line.trim() });
        }
      }
    }
  }
}

const rust = await readFile(join(REPO_ROOT, RUST_RECORDS), "utf8");
const rustValue = rust.match(RUST_AGENT)?.[1];
if (!rustValue) {
  console.error(`[session-agent] 读不出 ${RUST_RECORDS} 的 AGENT 常量；判据不能空转。`);
  process.exit(1);
}

// 判据必须报出「比了多少」，否则扫 0 处也会显示通过。
if (scanned === 0) {
  console.error("[session-agent] 一处 Node 侧的 agent 缺省值都没扫到；判据失效，按失败处理。");
  process.exit(1);
}

const drifted = [...defaults].filter((value) => value !== rustValue);
if (drifted.length > 0) {
  console.error(
    `[session-agent] Node 写 ${drifted.join(" / ")}，Rust 写 ${rustValue}：同一份会话库会出现两种 agent 值。`,
  );
  console.error(`  以 ${RUST_RECORDS} 的 AGENT 为准，两边同批改。`);
  process.exit(1);
}

if (violations.length > 0) {
  console.error(`[session-agent] ${violations.length} 处仍写上游名：`);
  for (const v of violations) {
    console.error(`  ${relative(REPO_ROOT, v.file)}:${v.line}  ${v.value}`);
    console.error(`    ${v.text}`);
  }
  process.exit(1);
}

console.log(
  `[session-agent] 通过：扫了 ${scanned} 处 Node 侧 agent 缺省值，全部等于 Rust 的 "${rustValue}"。`,
);
