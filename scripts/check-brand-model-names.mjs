#!/usr/bin/env node
/**
 * 判据：`GLM` / `glm` 作为**模型名**可以出现，作为产品/实例身份不行。
 *
 * 背景：全仓 `glm` 约 65% 是模型名（`GLM-5.3`、`glm-5.3-flashx` 等），直接禁掉
 * 会把模型目录、provider 配置和测试一起打红。判据顺序必须是：
 *   1. 先剔除模型名 token（`config/brand/model-name-allowlist.json` 的
 *      `modelIdPattern` + `explicitIds`）；
 *   2. 再找剩下的独立 `glm` token；
 *   3. 最后单独判 `zcode_database_identity`、`basedOnZCodeBuiltinRevision`、
 *      `clientType: "zcode"` 这类不带 glm、但同样属于上游身份的值。
 *
 * 这些**不是**模型名，不能靠 allowlist 当模型名放过：
 *   `provider: "glm"`、`mount: "glm/x64"`、`GLM_BINARY_PATH`、`glmDir`。
 * 它们只能走显式的行级 legacy 豁免（`legacyAllowedLines`，每条写理由），
 * 或者在同一行标 `legacy-migration`。不允许目录级白名单。
 *
 * 模型数据文件（provider 目录、官方模型 ID 名单、内核资源副本）用 `allowedFiles`
 * 整体豁免；模型定义行（`modelMatch` / `modelId` / `official(... ".*glm.*")`）
 * 用 `allowedLinePatterns` 豁免。新增白名单等于放宽判据，必须给理由。
 *
 * 扫描范围：受版本控制的运行时代码/配置（`packages`、`apps`、`kernel`、`config` 等）与
 * 构建脚本，排除测试、fixture 和文档。历史迁移里的 `glm`/`zcode_database_identity` 是
 * 数据事实（迁移 ID、旧表名不能重命名），必须按文件+行模式显式豁免；构建脚本里的
 * `glmDir` 由 B01/B03 单独跟踪，但同样必须显式豁免。
 *
 * 用法：node scripts/check-brand-model-names.mjs [repoRoot] [--self-test]
 * 退出码：0 = 干净；1 = 有命中或判据空转。
 */
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const rawArgs = process.argv.slice(2);
const SELF_TEST_ONLY = rawArgs.includes("--self-test");
const VERBOSE = rawArgs.includes("--verbose");
const REPO_ROOT = resolve(rawArgs.find((arg) => !arg.startsWith("--")) ?? join(HERE, ".."));
const ALLOWLIST_PATH = "config/brand/model-name-allowlist.json";

/** 只扫可能进入产品的源码/配置；注释、测试和文档不在这里判。 */
const SCAN_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".rs",
  ".sql",
  ".html",
  ".css",
  ".scss",
  ".yml",
  ".yaml",
  ".patch",
  ".ps1",
  ".cmd",
  ".sh",
  ".toml",
]);

const SKIP_PREFIXES = ["docs/", "third-party/", "apps/dev-docs/"];
const SKIP_PATHS = new Set([
  // 上游历史路径键，不是当前产品身份（与 check-visual-brand 同口径）。
  "scripts/architecture/upstream-snapshot.json",
  // 规则定义与自测样本必须包含被禁字符串，门禁不扫描自身。
  "scripts/check-brand-model-names.mjs",
  // allowlist 自身包含 modelIdPattern 与 legacy 模式，必然出现 glm 字样。
  "config/brand/model-name-allowlist.json",
]);
const SKIP_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "dist-types",
  "out",
  "coverage",
  "fixtures",
  "test",
  "tests",
  "__tests__",
  "e2e",
  "manual-review",
]);
const SKIP_FILE_PATTERNS = [
  /\.(?:test|spec)\.[^.]+$/i,
  /_tests?\.rs$/i,
  /(^|\/)test-model\.mjs$/i,
  /(^|\/)wdio\.conf\.ts$/i,
];

/** 模型名之外，判据还要单独抓的旧身份字段。 */
const FORBIDDEN_IDENTITY_PATTERNS = [
  { pattern: /\bzcode_database_identity\b/gi, reason: "SQLite 表名仍是上游 zcode_*" },
  { pattern: /\bbasedOnZCodeBuiltinRevision\b/g, reason: "线协议字段仍是上游 ZCode 命名" },
  {
    pattern: /\bclientType\s*[:=]\s*["']zcode["']/gi,
    reason: 'clientType 仍写字面上游 "zcode"',
  },
];

const LEGACY_MARKER = "legacy-migration";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function entryField(entry, field) {
  return typeof entry === "string" ? entry : entry[field];
}

function entryReason(entry) {
  return typeof entry === "string" ? "" : (entry.reason ?? "");
}

function normalizePath(value) {
  return value.replace(/\\/g, "/");
}

async function loadAllowlist() {
  const raw = JSON.parse(await readFile(join(REPO_ROOT, ALLOWLIST_PATH), "utf8"));
  if (raw.version !== 1) throw new Error(`${ALLOWLIST_PATH}: version 必须是 1`);
  if (typeof raw.modelIdPattern !== "string") {
    throw new Error(`${ALLOWLIST_PATH}: modelIdPattern 必须是字符串`);
  }
  let modelIdPattern;
  try {
    modelIdPattern = new RegExp(raw.modelIdPattern);
  } catch (error) {
    throw new Error(`${ALLOWLIST_PATH}: modelIdPattern 无法编译：${error.message}`);
  }
  if (!Array.isArray(raw.explicitIds) || !raw.explicitIds.every((id) => typeof id === "string")) {
    throw new Error(`${ALLOWLIST_PATH}: explicitIds 必须是字符串数组`);
  }
  if (!Array.isArray(raw.allowedFiles)) {
    throw new Error(`${ALLOWLIST_PATH}: allowedFiles 必须是数组`);
  }
  if (!Array.isArray(raw.allowedLinePatterns)) {
    throw new Error(`${ALLOWLIST_PATH}: allowedLinePatterns 必须是数组`);
  }
  if (!Array.isArray(raw.legacyAllowedLines)) {
    throw new Error(`${ALLOWLIST_PATH}: legacyAllowedLines 必须是数组`);
  }

  const allowedFiles = new Map();
  for (const entry of raw.allowedFiles) {
    const file = normalizePath(entryField(entry, "path"));
    if (!file) throw new Error(`${ALLOWLIST_PATH}: allowedFiles 条目缺少 path`);
    allowedFiles.set(file, entryReason(entry));
  }

  const allowedLinePatterns = raw.allowedLinePatterns.map((entry) => {
    const source = entryField(entry, "pattern");
    if (!source) throw new Error(`${ALLOWLIST_PATH}: allowedLinePatterns 条目缺少 pattern`);
    return {
      regex: new RegExp(source),
      source,
      reason: entryReason(entry),
      used: false,
    };
  });

  const legacyAllowedLines = raw.legacyAllowedLines.map((entry) => {
    const file = normalizePath(entry?.file);
    const source = entry?.pattern;
    if (!file || !source) {
      throw new Error(`${ALLOWLIST_PATH}: legacyAllowedLines 条目必须同时有 file 与 pattern`);
    }
    return {
      file,
      regex: new RegExp(source, "i"),
      source,
      reason: entry.reason ?? "",
      used: false,
    };
  });

  const explicit = [...raw.explicitIds].sort((a, b) => b.length - a.length);
  const body = raw.modelIdPattern.replace(/^\^/, "").replace(/\$$/, "");
  const modelTokenPattern = new RegExp(
    `(?<![A-Za-z0-9_-])(?:${[...explicit.map(escapeRegExp), body].join("|")})(?![A-Za-z0-9_])`,
    "gi",
  );

  return {
    modelIdPattern,
    explicitIds: raw.explicitIds,
    allowedFiles,
    allowedLinePatterns,
    legacyAllowedLines,
    modelTokenPattern,
  };
}

/** 去掉模型名 token，返回剩余文本与剔除数量。 */
function stripModelTokens(line, allowlist) {
  let removed = 0;
  allowlist.modelTokenPattern.lastIndex = 0;
  const rest = line.replace(allowlist.modelTokenPattern, () => {
    removed += 1;
    return "";
  });
  return { rest, removed };
}

/** 一行里所有非模型 glm 与禁用身份字段。 */
function findOffenders(line, allowlist) {
  const offenders = [];
  const { rest, removed } = stripModelTokens(line, allowlist);

  // 先剔除模型名，再判独立 glm。这里不要求右侧词边界：`glmDir`、`GLM_BINARY_PATH`
  // 也必须命中；左侧要求不是字母，避免把 `charglm-4` 这类模型名拆开。
  for (const match of rest.matchAll(/(?<![A-Za-z])glm/gi)) {
    offenders.push({ token: match[0], kind: "non-model-glm" });
  }

  for (const rule of FORBIDDEN_IDENTITY_PATTERNS) {
    rule.pattern.lastIndex = 0;
    for (const match of line.matchAll(rule.pattern)) {
      offenders.push({ token: match[0], kind: "forbidden-identity", reason: rule.reason });
    }
  }

  return { offenders, modelTokensRemoved: removed };
}

/** 行级 legacy 豁免：inline marker → allowedFiles → legacyAllowedLines。 */
function lineExemptionFor(file, line, allowlist) {
  if (line.includes(LEGACY_MARKER)) {
    return { kind: "inline", reason: LEGACY_MARKER };
  }
  if (allowlist.allowedFiles.has(file)) {
    return { kind: "allowed-file", reason: allowlist.allowedFiles.get(file) };
  }
  for (const rule of allowlist.legacyAllowedLines) {
    if (rule.file !== file) continue;
    rule.regex.lastIndex = 0;
    if (rule.regex.test(line)) {
      rule.used = true;
      return { kind: "legacy-line", reason: rule.reason };
    }
  }
  return null;
}

/** 模型定义行豁免：只放过非模型 glm，不放过 `zcode_database_identity` 等身份字段。 */
function allowedLinePatternFor(line, allowlist) {
  for (const rule of allowlist.allowedLinePatterns) {
    rule.regex.lastIndex = 0;
    if (rule.regex.test(line)) {
      rule.used = true;
      return rule;
    }
  }
  return null;
}

/** 一行最终是否命中：先剔除模型名，再套行级/模型定义豁免。 */
function classifyLine(file, line, allowlist) {
  const { offenders, modelTokensRemoved } = findOffenders(line, allowlist);
  const lineExemption = lineExemptionFor(file, line, allowlist);
  const patternRule = allowedLinePatternFor(line, allowlist);
  const active = [];
  for (const offender of offenders) {
    if (lineExemption) continue;
    if (offender.kind === "non-model-glm" && patternRule) continue;
    active.push(offender);
  }
  return {
    offenders: active,
    modelTokensRemoved,
    exempted: offenders.length > 0 && active.length === 0,
  };
}

function shouldScan(file) {
  if (SKIP_PATHS.has(file)) return false;
  if (SKIP_PREFIXES.some((prefix) => file.startsWith(prefix))) return false;
  if (file.split("/").some((segment) => SKIP_SEGMENTS.has(segment))) return false;
  if (SKIP_FILE_PATTERNS.some((pattern) => pattern.test(file))) return false;
  const dot = file.lastIndexOf(".");
  if (dot < 0) return false;
  return SCAN_EXTENSIONS.has(file.slice(dot).toLowerCase());
}

async function listTrackedFiles() {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.split("\0").filter(Boolean).map(normalizePath);
}

function runSelfTest(allowlist) {
  const cases = [
    { line: 'const model = "GLM-5.3";', expected: 0, label: "模型名 GLM-5.3" },
    { line: 'const model = "GLM-4.7-FlashX";', expected: 0, label: "模型名 GLM-4.7-FlashX" },
    { line: 'const model = "glm-5.3-flashx";', expected: 0, label: "模型名 glm-5.3-flashx" },
    { line: 'const model = "charglm-4";', expected: 0, label: "模型名 charglm-4" },
    { line: '"modelMatch": ".*glm.*",', expected: 0, label: "modelMatch 规则行" },
    { line: "const id = OFFICIAL_GLM_MODEL_IDS[0];", expected: 0, label: "官方模型名单引用" },
    { line: 'provider: "glm",', expected: 1, label: 'provider: "glm"' },
    { line: "mount: `glm/x64`,", expected: 1, label: "mount: glm/x64" },
    { line: 'const GLM_BINARY_PATH = "/opt/bin";', expected: 1, label: "GLM_BINARY_PATH" },
    { line: 'const glmDir = "/opt/bin";', expected: 1, label: "glmDir" },
    {
      line: "CREATE TABLE zcode_database_identity (scope TEXT);",
      expected: 1,
      label: "zcode_database_identity",
    },
    {
      line: 'basedOnZCodeBuiltinRevision: "x",',
      expected: 1,
      label: "basedOnZCodeBuiltinRevision",
    },
    { line: 'clientType: "zcode",', expected: 1, label: 'clientType: "zcode"' },
    { line: '// legacy-migration: provider: "glm"', expected: 0, label: "legacy-migration 行" },
  ];
  let failed = 0;
  for (const testCase of cases) {
    const { offenders } = classifyLine("__self_test__.ts", testCase.line, allowlist);
    const actual = offenders.length;
    if (actual !== testCase.expected) {
      failed += 1;
      console.error(
        `[brand-model-names] self-test 失败：${testCase.label} 期望 ${testCase.expected} 命中，实际 ${actual}`,
      );
    }
  }
  if (failed > 0) process.exit(1);
  console.log(
    `[brand-model-names] self-test 通过：${cases.length}/${cases.length} 个样本（模型名、provider/mount/GLM_BINARY_PATH/glmDir、身份字段、行级豁免）。`,
  );
}

async function main() {
  const allowlist = await loadAllowlist();
  runSelfTest(allowlist);
  // self-test 会命中部分规则；实际扫描前清零，verbose 才能看出哪些规则空转。
  for (const rule of [...allowlist.allowedLinePatterns, ...allowlist.legacyAllowedLines]) {
    rule.used = false;
  }
  if (SELF_TEST_ONLY) return;

  const trackedFiles = await listTrackedFiles();
  const files = trackedFiles.filter(shouldScan);
  const tracked = new Set(trackedFiles);
  for (const file of allowlist.allowedFiles.keys()) {
    if (!tracked.has(file)) {
      console.error(`[brand-model-names] allowedFiles 指向不存在的受控文件：${file}`);
      process.exit(1);
    }
  }
  const violations = [];
  const counts = new Map();
  let scannedFiles = 0;
  let linesWithGlm = 0;
  let modelTokensRemoved = 0;
  let exemptedLines = 0;

  for (const file of files) {
    if (allowlist.allowedFiles.has(file)) {
      continue;
    }
    let text;
    try {
      text = await readFile(join(REPO_ROOT, file), "utf8");
    } catch {
      continue;
    }
    scannedFiles += 1;
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!/glm|zcode_database_identity|basedOnZCodeBuiltinRevision|clientType/i.test(line)) {
        continue;
      }
      // 纯注释行不会进入产物；只在代码/配置/字符串字面量上判。
      if (/^\s*(?:\/\/|\/\*|\*|#|--|<!--)/.test(line)) continue;
      const {
        offenders,
        modelTokensRemoved: removed,
        exempted,
      } = classifyLine(file, line, allowlist);
      modelTokensRemoved += removed;
      if (/glm/i.test(line)) linesWithGlm += 1;
      if (offenders.length === 0) {
        if (exempted) exemptedLines += 1;
        continue;
      }
      for (const offender of offenders) {
        const key = `${offender.kind}: ${offender.token}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        violations.push({
          file,
          line: index + 1,
          context: line.trim().slice(0, 200),
          ...offender,
        });
      }
    }
  }

  if (scannedFiles === 0) {
    console.error("[brand-model-names] 一个可扫文件都没有；判据空转，按失败处理。");
    process.exit(1);
  }

  if (violations.length > 0) {
    console.error(`[brand-model-names] ${violations.length} 处非模型 glm / 禁用身份字段：`);
    for (const [key, count] of [...counts].sort((a, b) => b[1] - a[1])) {
      console.error(`  ${String(count).padStart(5)}  ${key}`);
    }
    console.error("");
    for (const hit of violations.slice(0, VERBOSE ? violations.length : 40)) {
      console.error(`  ${hit.file}:${hit.line}`);
      console.error(`    ${hit.context}`);
      if (hit.reason) console.error(`    理由：${hit.reason}`);
    }
    if (!VERBOSE && violations.length > 40) {
      console.error(`  ...其余 ${violations.length - 40} 处省略`);
    }
    console.error(
      "\n模型名请写进 config/brand/model-name-allowlist.json 的 modelIdPattern/explicitIds；" +
        "非模型的现存合法项只允许在 legacyAllowedLines 里按文件+行模式显式豁免并写理由，" +
        "或在同一行标 legacy-migration。",
    );
    process.exit(1);
  }

  console.log(
    `[brand-model-names] 通过：扫了 ${scannedFiles} 个源码/配置文件` +
      `（${allowlist.allowedFiles.size} 个模型数据/供应商图标文件整体豁免），` +
      `含 glm 的行 ${linesWithGlm}，剔除模型名 token ${modelTokensRemoved} 处；` +
      `非模型 glm 0 处。` +
      `行级豁免 ${exemptedLines} 行（allowedLinePatterns ${allowlist.allowedLinePatterns.length} 条、` +
      `legacyAllowedLines ${allowlist.legacyAllowedLines.length} 条）。`,
  );
  if (VERBOSE) {
    const unused = [
      ...allowlist.allowedLinePatterns
        .filter((rule) => !rule.used)
        .map((rule) => `allowedLinePatterns: ${rule.source}`),
      ...allowlist.legacyAllowedLines
        .filter((rule) => !rule.used)
        .map((rule) => `legacyAllowedLines: ${rule.file} :: ${rule.source}`),
    ];
    if (unused.length > 0) {
      console.log(`  本轮未命中的豁免 ${unused.length} 条：`);
      for (const line of unused) console.log(`    ${line}`);
    }
  }
}

await main();
