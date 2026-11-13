#!/usr/bin/env node
/**
 * 判据：渲染层与主进程的**持久化键**不许用上游 ZCode 的名字。
 *
 * 为什么单独一条判据：`check-identity-residue.mjs` 只扫**构建产物**，而且盯的是实例身份
 * （数据根、CLI 名、请求头）。持久化键是另一类问题——它不体现在打包结果里，
 * 但它决定「我们会去读写哪个产品的数据」。键名带着 `nibi-` / `zai-` 时，
 * 同一台机器上装了上游 ZCode 就是在共享它的存储。
 *
 * 扫的是**源码**（不像 identity-residue 扫产物）：键名在源码里就是字面量或常量，
 * 不需要构建就能判；而且越早发现越好。
 *
 * 判据范围：`localStorage.*( / sessionStorage.*(` 调用里的键名，以及
 * `*_STORAGE_KEY = "..."` 这类常量定义。其它地方出现的 `nibi-`（插件名、IPC 通道、
 * 文件名）不在本判据范围，别在这里加规则。
 *
 * 允许清单：与**外部**交换的键（第三方 Gen-UI / MCP / CUA 面板读同一份数据），
 * 改名会打断别人的面板。每条都要写清为什么不能改。
 *
 * 用法：node scripts/check-storage-keys.mjs
 * 退出码：0 = 干净；1 = 有命中。
 */
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(process.argv[2] ?? join(HERE, ".."));

/**
 * 允许保留旧名的键（与外部交换的契约）。
 *
 * 判断标准：这份数据**不是只有我们自己读写**。插件 / Gen-UI / MCP / CUA 面板通过它
 * 与我们交换状态，改名会让已发布的第三方面板读不到。这类键属于插件兼容层，
 * 是运营者明确允许的唯一例外。
 */
const ALLOWED_KEYS = [
  // Gen-UI / MCP Apps 的元数据键（`zcode/genUiTweaks`、`zcode/widgetState`、`zcode/csp` 等）：
  // 注入给**第三方** gen-ui 面板的上下文，面板按这些键取值。改名要同步所有已发布的
  // gen-ui 产物，属于插件 ABI 兼容层——运营者明确允许的唯一例外。
  { pattern: /^zcode\//, reason: "Gen-UI / MCP Apps 元数据命名空间，第三方面板按此取值" },
  // CUA 面板元数据键（`nibi.cua/app-associations-v1` 等）：CUA 契约层与面板共用。
  { pattern: /^nibi\.cua\//, reason: "CUA 面板元数据键，CUA 契约与面板共用" },
  //
  // 不属于本判据、**不要**加进来的：
  // - 模型 provider id（`zai` / `bigmodel`）：第三方服务商标识，改了就调不通；
  // - `clientType: "zcode"`：z.ai 的服务端契约字段。
];

/**
 * 键名常量定义的形态：`const X_STORAGE_KEY = "..."` 与 `X_KEY_PREFIX = "..."`。
 *
 * 只认 `STORAGE_KEY` 会漏掉 `COMPOSER_RECENT_KEY_PREFIX` 这类前缀常量——
 * 实测踩过：那个常量没被改名，5 条测试因此失败，而判据当时是绿的。
 */
const KEY_CONSTANT = /\b[A-Z][A-Z0-9_]*(?:STORAGE_KEY|KEY[A-Z0-9_]*)\b\s*=\s*["']([^"']+)["']/g;
/** 直接的存储调用形态。 */
const STORAGE_CALL =
  /\b(?:localStorage|sessionStorage)\s*\.\s*(?:getItem|setItem|removeItem)\s*\(\s*["'`]([^"'`]+)["'`]/g;
/**
 * 我们自己的安全包装（`readSafeLocalStorage("...")` 等）。
 *
 * 只认裸 `localStorage.*(` 会漏掉它们——实测踩过：`nibi-locale` 就是这样
 * 一直留在 `store/index.ts` 里而判据是绿的。
 */
const SAFE_STORAGE_CALL =
  /\b(?:read|write|remove)SafeLocalStorage\s*\(\s*["'`]([^"'`]+)["'`]/g;

const UPSTREAM_PREFIX = /^z(code|ai)/i;

async function listSources() {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "-z", "--", "packages", "apps", "scripts", "kernel"],
    { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout
    .split("\0")
    .filter(Boolean)
    .filter((f) => /\.(ts|tsx|mts|cts|js|mjs|cjs|html)$/.test(f))
    .filter((f) => !f.includes("dist-types/") && !f.includes("node_modules/"));
}

function isAllowed(key) {
  return ALLOWED_KEYS.some(({ pattern }) => pattern.test(key));
}

const violations = [];
let scannedFiles = 0;
let scannedKeys = 0;

for (const file of await listSources()) {
  let text;
  try {
    text = await readFile(join(REPO_ROOT, file), "utf8");
  } catch {
    continue;
  }
  scannedFiles += 1;
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (/^\s*(\/\/|\*|<!--)/.test(line)) continue;
    for (const regex of [KEY_CONSTANT, STORAGE_CALL, SAFE_STORAGE_CALL]) {
      regex.lastIndex = 0;
      for (const match of line.matchAll(regex)) {
        const key = match[1];
        if (!UPSTREAM_PREFIX.test(key)) continue;
        scannedKeys += 1;
        if (isAllowed(key)) continue;
        violations.push({
          file,
          line: index + 1,
          key,
          context: line.trim().slice(0, 160),
        });
      }
    }
  }
}

if (violations.length > 0) {
  console.error(`[storage-keys] ${violations.length} 处持久化键仍在用上游名：`);
  for (const v of violations) {
    console.error(`  ${relative(REPO_ROOT, v.file)}:${v.line}  ${v.key}`);
    console.error(`    ${v.context}`);
  }
  console.error(
    "\n改成 NIBI 的键名（nibi: / nibi-）。NIBI 没有存量用户，不需要兼容旧键；" +
      "与第三方面板交换的键请加进本文件的 ALLOWED_KEYS 并写明理由。",
  );
  process.exit(1);
}

// 判据必须报出「比了多少」，否则空转（比 0 个键）也会显示通过。
console.log(
  `[storage-keys] 通过：扫了 ${scannedFiles} 个源码文件、${scannedKeys} 个上游前缀键引用，全部在允许清单内或已改名。`,
);
