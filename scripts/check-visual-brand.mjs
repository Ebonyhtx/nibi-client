#!/usr/bin/env node
/**
 * 上游视觉签名门禁。
 *
 * 目的：把「看起来像上游」变成可判定的失败。扫描受版本控制的源码/样式里的
 * 上游签名色与旧主题标识；迁移兼容代码必须显式标注 `legacy-migration`。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const SCAN_EXTENSIONS = new Set([
  ".css",
  ".scss",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".html",
]);

const SKIP_PATHS = new Set([
  // 上游快照记录上游路径/哈希，保留上游原貌，不参与本地品牌门禁。
  "scripts/architecture/upstream-snapshot.json",
]);

const SKIP_PREFIXES = ["docs/", "third-party/"];

const RULES = [
  {
    id: "upstream-sky-400",
    pattern: /#80beff/gi,
    message: "上游签名色 #80BEFF",
  },
  {
    id: "upstream-sky-500",
    pattern: /#4099ff/gi,
    message: "上游签名色 #4099FF",
  },
  {
    id: "upstream-navy",
    pattern: /#001d3d/gi,
    message: "上游签名色 #001D3D",
  },
  {
    id: "theme-zai",
    pattern: /\bzai-(?:light|dark)\b/gi,
    message: "旧主题标识 zai-*；迁移代码请在同一行标注 legacy-migration",
  },
  {
    id: "theme-zai-class",
    pattern: /\btheme-zai\b/gi,
    message: "旧主题 class theme-zai；迁移代码请在同一行标注 legacy-migration",
  },
  {
    id: "brand-sky-token",
    pattern: /--color-brand\s*:\s*var\(--color-sky-\d+\)/gi,
    message: "brand token 仍引用上游 sky 色阶",
  },
];

function listTrackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: process.cwd(),
    maxBuffer: 64 * 1024 * 1024,
  });
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function shouldScan(path) {
  if (SKIP_PATHS.has(path)) return false;
  if (SKIP_PREFIXES.some((prefix) => path.startsWith(prefix))) return false;
  return SCAN_EXTENSIONS.has(extname(path).toLowerCase());
}

export function findViolations(path, text) {
  const violations = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.includes("legacy-migration")) continue;
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      if (!rule.pattern.test(line)) continue;
      violations.push({
        file: path,
        line: index + 1,
        rule: rule.id,
        message: rule.message,
        excerpt: line.trim().slice(0, 160),
      });
    }
  }
  return violations;
}

function runSelfTest() {
  const sample = [
    "const brand = '#4099FF';",
    ".theme-zai-dark { --x: #80BEFF; }",
    "// legacy-migration: 'zai-dark' 是旧值",
  ].join("\n");
  const violations = findViolations("__self_test__.css", sample);
  const rules = new Set(violations.map((violation) => violation.rule));
  const expected = ["upstream-sky-400", "upstream-sky-500", "theme-zai", "theme-zai-class"];
  const missing = expected.filter((rule) => !rules.has(rule));
  if (missing.length > 0 || violations.length !== 4) {
    console.error(
      `check-visual-brand self-test failed: expected 4 violations (${expected.join(", ")}), got ${violations.length} (${[...rules].join(", ")})`,
    );
    process.exit(1);
  }
  console.log("check-visual-brand self-test: OK (4/4 violations caught, legacy line ignored)");
}

function main() {
  if (process.argv.includes("--self-test")) {
    runSelfTest();
    return;
  }

  const files = listTrackedFiles().filter(shouldScan);
  const violations = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    violations.push(...findViolations(file, text));
  }

  if (violations.length === 0) {
    console.log(`check-visual-brand: OK (${files.length} files scanned)`);
    return;
  }

  for (const violation of violations) {
    console.error(
      `${violation.file}:${violation.line}: [${violation.rule}] ${violation.message}\n    ${violation.excerpt}`,
    );
  }
  console.error(
    `\ncheck-visual-brand: ${violations.length} violation(s) across ${new Set(violations.map((v) => v.file)).size} file(s).`,
  );
  process.exit(1);
}

main();
