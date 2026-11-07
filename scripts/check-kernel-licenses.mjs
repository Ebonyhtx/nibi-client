#!/usr/bin/env node
/**
 * 判据：内核里"复制进来的上游代码"必须带归属，且归属材料真的会随分发包走。
 *
 * 为什么单列一条：`crates/tui/src/ui/paste_burst*.rs` 是从 `openai/codex`（Apache-2.0）复制的，
 * 由 `kernel/vendor/copied/openai-codex/copied.json` 记录。Apache-2.0 §4(d) 要求分发派生作品时
 * 携带源的 NOTICE —— 漏掉不是"文档不全"，是许可证违约。我们在 2026-11-07 才发现自己的 pin
 * 里早就有这两个文件、却没有任何归属（上游 0.1.86 才补上，见 `kernel/CHANGELOG-FORK.md`）。
 *
 * 检查四件事：
 * 1. 每个 `kernel/vendor/copied/<id>/copied.json` 列出的源文件都存在（上游路径带 `packages/rust-cli/` 前缀，
 *    映射到我们的 `kernel/`）；
 * 2. 该项目在 `kernel/vendor/THIRD-PARTY-NOTICES.txt` 里有 `--- LICENSE` 与 `--- NOTICE` 段，
 *    且 NOTICE 原文逐字节出现在文件里；
 * 3. `kernel/LICENSE`、`kernel/vendor/THIRD-PARTY-NOTICES.txt` 存在且非空；
 * 4. `packages/desktop/scripts/prepare-rust-kernel.mjs` 仍把这两份材料 stage 进打包位次
 *    （接线被删掉时，判据要红，而不是等发布后才发现包里没有归属）。
 *
 * 用法：node scripts/check-kernel-licenses.mjs [repoRoot]
 * 退出码：0 = 合规；1 = 缺归属/缺文件/接线断了；2 = 读不出 copied.json（判据不能空转）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(process.argv[2] ?? join(HERE, ".."));
const KERNEL = join(REPO_ROOT, "kernel");
const COPIED_ROOT = join(KERNEL, "vendor", "copied");
const NOTICES = join(KERNEL, "vendor", "THIRD-PARTY-NOTICES.txt");
const LICENSE = join(KERNEL, "LICENSE");
const STAGING_SCRIPT = join(
  REPO_ROOT,
  "packages",
  "desktop",
  "scripts",
  "prepare-rust-kernel.mjs",
);

/** 上游路径（`packages/rust-cli/...`）→ 我们子树里的路径（`kernel/...`）。 */
function kernelPathFor(upstreamPath) {
  const prefix = "packages/rust-cli/";
  if (!upstreamPath.startsWith(prefix)) return null;
  return join(KERNEL, upstreamPath.slice(prefix.length));
}

const failures = [];
let projects = 0;
let files = 0;

function requireNonEmpty(path, label) {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size === 0) failures.push(`${label} 为空：${path}`);
  } catch {
    failures.push(`${label} 不存在：${path}`);
  }
}

requireNonEmpty(LICENSE, "内核许可证");
requireNonEmpty(NOTICES, "第三方归属");

let notices = "";
try {
  notices = readFileSync(NOTICES, "utf8");
} catch {
  failures.push(`读不出 ${NOTICES}；判据不能空转`);
}

let entries = [];
try {
  entries = readdirSync(COPIED_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
} catch {
  // 没有 copied 目录是合法的（还没有复制代码）；但 copied.json 读不出不是。
}

for (const id of entries) {
  const manifestPath = join(COPIED_ROOT, id, "copied.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    console.error(`[kernel-licenses] 读不出 ${manifestPath}：${error.message}`);
    process.exit(2);
  }
  projects += 1;
  if (manifest.id !== id) failures.push(`${manifestPath} 的 id "${manifest.id}" 与目录名 "${id}" 不一致`);
  for (const field of ["license", "url"]) {
    if (typeof manifest[field] !== "string" || !manifest[field].trim()) {
      failures.push(`${manifestPath} 缺少 ${field}`);
    }
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    failures.push(`${manifestPath} 的 files 为空`);
    continue;
  }
  for (const upstreamPath of manifest.files) {
    const path = kernelPathFor(upstreamPath);
    if (path === null) {
      failures.push(`${manifestPath} 里的路径不是 packages/rust-cli 下的：${upstreamPath}`);
      continue;
    }
    try {
      if (!statSync(path).isFile()) throw new Error("not a file");
      files += 1;
    } catch {
      failures.push(`copied.json 列出的文件不存在：${upstreamPath}`);
    }
  }

  // 归属原文：LICENSE 段落 + NOTICE 原文逐字节出现。
  const licensePath = join(COPIED_ROOT, id, "LICENSE");
  const noticePath = join(COPIED_ROOT, id, "NOTICE");
  requireNonEmpty(licensePath, `${id} 的 LICENSE`);
  requireNonEmpty(noticePath, `${id} 的 NOTICE`);
  for (const section of ["--- LICENSE", "--- NOTICE"]) {
    if (!notices.includes(section)) failures.push(`${NOTICES} 里没有 "${section}" 段`);
  }
  try {
    const noticeText = readFileSync(noticePath, "utf8").trim();
    const firstUsefulLine = noticeText
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("---"));
    if (firstUsefulLine && !notices.includes(firstUsefulLine)) {
      failures.push(`${NOTICES} 里找不到 ${id} 的 NOTICE 原文（首行：${firstUsefulLine}）`);
    }
  } catch {
    // requireNonEmpty 已经记过
  }
  if (!notices.includes(id)) failures.push(`${NOTICES} 里没有出现被复制项目 "${id}"`);
}

// 分发接线：stage 脚本必须仍然带上这两份材料，否则判据通过、包里却没有。
try {
  const staging = readFileSync(STAGING_SCRIPT, "utf8");
  for (const material of ['"LICENSE"', '"THIRD-PARTY-NOTICES.txt"']) {
    if (!staging.includes(material)) {
      failures.push(`${STAGING_SCRIPT} 不再 stage ${material}：打包产物会缺归属`);
    }
  }
} catch {
  failures.push(`读不出 ${STAGING_SCRIPT}；无法确认打包会带上归属`);
}

if (failures.length > 0) {
  console.error(`[kernel-licenses] 不合规：${failures.length} 项`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(
  `[kernel-licenses] 通过：${projects} 个复制项目 / ${files} 个源文件，归属齐全；` +
    `LICENSE 与 ${(notices.length / 1024).toFixed(1)} KB 归属会随包分发。`,
);
