#!/usr/bin/env node
/**
 * 客户端全局 a11y 门禁。
 *
 * 为什么需要：插件面板已经有一份键盘/读屏门禁，但客户端主体（settings / chat / sidebar /
 * v4 会话等）没有。纯靠人看截图看不出「控件没有可访问名称」「role 用错」「label 没关联」
 * 这类问题，所以把 jsx-a11y 的静态规则变成机器判据。
 *
 * 判据分两层：
 *   1. **error 规则**：无障碍正确性（无效 role、aria-* 用在错误 role、label 没关联控件等），
 *      必须为 0；出现即失败。
 *   2. **warning 规则**：交互/焦点类建议（no-autofocus、no-static-element-interactions 等），
 *      存量记在 scripts/a11y-baseline.json 里；**新增一条就失败**，避免"门禁绿但越来越烂"。
 *
 * 用法：
 *   node scripts/check-ui-a11y.mjs
 *   node scripts/check-ui-a11y.mjs --update-baseline   # 有意接受新的 warning 时
 *
 * 输出必须包含「扫了几个根、命中多少文件/规则、多少条诊断、基线多少、新增多少」，
 * 避免判据静默空转（见 docs/engineering 的门禁纪律）。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG = join(ROOT, ".oxlintrc.a11y.json");
const BASELINE = join(ROOT, "scripts", "a11y-baseline.json");
const TARGETS = ["packages/ui/src", "packages/desktop/src/renderer"];
const A11Y_CODE = "eslint-plugin-jsx-a11y(";
const UPDATE = process.argv.includes("--update-baseline");

function fail(message) {
  console.error(`a11y gate: ${message}`);
  process.exit(1);
}

function runOxlint() {
  const binary = join(ROOT, "node_modules", "oxlint", "bin", "oxlint");
  if (!existsSync(binary)) fail(`找不到 oxlint（${binary}），先跑 pnpm install`);
  const args = ["-c", CONFIG, "--format=json", ...TARGETS];
  const result = spawnSync(process.execPath, [binary, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) fail(`oxlint 启动失败：${result.error.message}`);
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (!stdout.trim()) {
    // 配置错误 / 插件未安装时 oxlint 只写 stderr；把原文带出来，别让门禁静默通过。
    fail(`oxlint 没有输出（exit=${result.status}）：${stderr.trim().slice(0, 1200) || "无 stderr"}`);
  }
  let payload;
  try {
    payload = JSON.parse(stdout);
  } catch (error) {
    fail(`oxlint 输出不是 JSON（exit=${result.status}）：${String(error)}；stderr=${stderr.trim().slice(0, 800)}`);
  }
  if (!Array.isArray(payload?.diagnostics)) fail("oxlint 输出缺少 diagnostics 数组");
  return payload.diagnostics;
}

function readBaseline() {
  if (!existsSync(BASELINE)) {
    fail(`缺少基线 ${BASELINE}；先跑 node scripts/check-ui-a11y.mjs --update-baseline`);
  }
  try {
    const payload = JSON.parse(readFileSync(BASELINE, "utf8"));
    return payload?.counts && typeof payload.counts === "object" ? payload.counts : {};
  } catch (error) {
    fail(`基线不可读：${String(error)}`);
  }
}

function writeBaseline(counts) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  const payload = {
    version: 1,
    note:
      "jsx-a11y warning 存量账本。新增 warning 会被 check-ui-a11y 判失败；" +
      "有意接受时跑 node scripts/check-ui-a11y.mjs --update-baseline。error 规则不允许进基线。",
    counts: sorted,
  };
  writeFileSync(BASELINE, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

const diagnostics = runOxlint().filter((item) => String(item?.code ?? "").includes(A11Y_CODE));
const errors = diagnostics.filter((item) => item.severity === "error");
const warnings = diagnostics.filter((item) => item.severity === "warning");
const files = new Set(diagnostics.map((item) => item.filename));
const rules = new Set(diagnostics.map((item) => item.code));

const counts = {};
for (const item of warnings) {
  const key = `${item.filename}|${item.code}`;
  counts[key] = (counts[key] ?? 0) + 1;
}

if (UPDATE) {
  if (errors.length > 0) {
    console.error(`a11y gate: 有 ${errors.length} 条 error，不能写进基线：`);
    for (const item of errors.slice(0, 40)) {
      const line = item.labels?.[0]?.span?.line ?? "?";
      console.error(`  ${item.filename}:${line} ${item.code} ${item.message}`);
    }
    process.exit(1);
  }
  writeBaseline(counts);
  console.log(
    `a11y gate: 已写入基线 ${BASELINE}（${Object.keys(counts).length} 个 file+rule，` +
      `${warnings.length} 条 warning；扫了 ${files.size} 个文件 / ${rules.size} 条规则）`,
  );
  process.exit(0);
}

if (errors.length > 0) {
  console.error(`a11y gate: ${errors.length} 条 error（必须修，不能基线化）：`);
  for (const item of errors.slice(0, 40)) {
    const line = item.labels?.[0]?.span?.line ?? "?";
    console.error(`  ${item.filename}:${line} ${item.code} ${item.message}`);
  }
  if (errors.length > 40) console.error(`  …还有 ${errors.length - 40} 条`);
  process.exit(1);
}

const baseline = readBaseline();
const newFindings = [];
let newTotal = 0;
for (const [key, current] of Object.entries(counts)) {
  const allowed = Number(baseline[key] ?? 0);
  if (current > allowed) {
    newTotal += current - allowed;
    newFindings.push(`${key}（基线 ${allowed}，现在 ${current}）`);
  }
}
let stale = 0;
for (const [key, allowed] of Object.entries(baseline)) {
  const current = counts[key] ?? 0;
  if (current < Number(allowed)) stale += 1;
}

console.log(
  `a11y gate: 扫了 ${TARGETS.length} 个根目录 / ${files.size} 个文件 / ${rules.size} 条 a11y 规则；` +
    `诊断 ${diagnostics.length} 条（error ${errors.length} / warning ${warnings.length}）；` +
    `基线覆盖 ${Object.keys(baseline).length} 个 file+rule；新增 ${newTotal}；基线可收紧 ${stale}`,
);
if (newTotal > 0) {
  console.error("a11y gate: 发现新增 warning：");
  for (const item of newFindings.slice(0, 40)) console.error(`  ${item}`);
  if (newFindings.length > 40) console.error(`  …还有 ${newFindings.length - 40} 个 file+rule`);
  console.error("  修掉，或确认接受后跑 node scripts/check-ui-a11y.mjs --update-baseline");
  process.exit(1);
}
if (stale > 0) {
  console.log(
    `a11y gate: 基线里有 ${stale} 个 file+rule 已不再出现；可跑 --update-baseline 收紧（不阻塞）`,
  );
}
