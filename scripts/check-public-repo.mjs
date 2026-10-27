#!/usr/bin/env node
/**
 * Public-repository policy check.
 *
 * The public source tree must never contain private infrastructure, operator
 * paths, credentials, or internal-only workflows. This script is intentionally
 * dependency-free so it can run before `pnpm install`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

const ROOT = process.cwd();

const TEXT_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".yml",
  ".yaml",
  ".sh",
  ".bash",
  ".ps1",
  ".cmd",
  ".bat",
  ".py",
  ".toml",
  ".txt",
  ".css",
  ".html",
  ".mmd",
  ".nsh",
  ".iss",
  ".cs",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".xml",
  ".plist",
  ".gradle",
  ".properties",
]);

const SKIP_FILES = new Set([
  "scripts/check-public-repo.mjs",
  "pnpm-lock.yaml",
  "package-lock.json",
  "scripts/architecture/upstream-snapshot.json",
]);

// A self-signed leaf key used only by the HTTP CONNECT proxy TLS regression
// test. The matching certificate is issued for `content.test`, which cannot be
// trusted by any real client, so shipping this key has no credential value.
// Keep this list exact: never allow a directory or a filename pattern.
const ALLOWED_PRIVATE_KEY_FILES = new Set([
  "apps/zcode-cli/packages/adapters/tests/fixtures/proxy-tls/leaf-key.pem",
]);

const BINARY_KEY_EXTENSIONS = new Set([".key", ".p12", ".pfx", ".jks", ".keystore"]);

// Fake values used by existing tests and documentation.
const ALLOWED_SNIPPETS = [
  "sk-1234567890abcdefghijklmnopqrstuv",
  "sk-abcdefghijklmnopqrstuv0123456789",
  "sk-abcdefghijklmnopqrstuvwx",
  "ghp_123456789012345678901234567890",
  "AKIAIOSFODNN7EXAMPLE",
  "/Users/alice/repo",
  "/Users/alice/",
  "169.254.169.254",
  "pem-canary",
  "FAKE_SECRET",
  "/Users/example",
  "/Users/test",
  "/Users/xxxxx",
  "/Users/FAKE_USER",
  "/home/test",
  "/home/u",
  "8.8.8.8",
  "1.1.1.1",
  "172.32.2.3",
];

const RULES = [
  {
    // A raw public IPv4 URL is almost always an internal host or a leaked
    // deployment detail. Test-NET, loopback, link-local, and RFC1918 ranges are
    // excluded so normal test fixtures stay valid.
    name: "raw public IPv4 URL",
    re: /https?:\/\/(?!127\.|0\.0\.0\.0|localhost|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|203\.0\.113\.|198\.51\.100\.|192\.0\.2\.)\d{1,3}(?:\.\d{1,3}){3}/i,
  },
  {
    name: "workspace absolute path",
    re: /(?:[A-Za-z]:[\\/]NIBI[\\/]|\/d\/NIBI\/)/,
  },
  {
    name: "private key material",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
  },
  {
    name: "GitHub token",
    re: /\bgh[pousr]_[A-Za-z0-9]{36}\b/,
  },
  {
    name: "fine-grained GitHub token",
    re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  },
  {
    name: "openai-style key",
    re: /\bsk-[A-Za-z0-9]{32,}\b/,
  },
  {
    name: "AWS access key",
    re: /\bAKIA[0-9A-Z]{16}\b/,
  },
  {
    name: "internal document directory",
    re: /\bdocs\/(?:working-memory|superpowers|monitoring|analysis|ci|issues|plans?|trace|upstream|v4-refactor)\//,
  },
  {
    name: "private workflow or script",
    re: /\b(?:real-model-nightly|sign-windows-hook|smoke-real-model|doctor-macos-release-app)\b/,
  },
];

function listTrackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
  });
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function isTextFile(file) {
  if (SKIP_FILES.has(file)) return false;
  if (file.split("/").some((part) => part === "node_modules" || part === "dist" || part === "out")) {
    return false;
  }
  return TEXT_EXTENSIONS.has(extname(file).toLowerCase());
}

function isAllowed(line) {
  return ALLOWED_SNIPPETS.some((snippet) => line.includes(snippet));
}

function scanWorkflowShape(file, lines) {
  const violations = [];
  const isWorkflow = file.startsWith(".github/workflows/") && /\.ya?ml$/.test(file);
  if (!isWorkflow) return violations;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*#/.test(line)) continue;
    const uses = line.match(/^\s*(?:-\s*)?uses:\s*(\S+)/);
    if (uses) {
      const spec = uses[1];
      const isLocal = spec.startsWith("./") || spec.startsWith("docker://");
      const isPinned = /@[0-9a-f]{40}$/.test(spec);
      if (!isLocal && !isPinned) {
        violations.push({
          file,
          line: index + 1,
          rule: "action not pinned to a full commit SHA",
          text: line.trim(),
        });
      }
    }
    if (/\bsecrets\./.test(line)) {
      violations.push({
        file,
        line: index + 1,
        rule: "public workflow references secrets",
        text: line.trim(),
      });
    }
    if (/\bself-hosted\b/.test(line)) {
      violations.push({
        file,
        line: index + 1,
        rule: "public workflow uses a self-hosted runner",
        text: line.trim(),
      });
    }
    if (/\bpull_request_target\b/.test(line)) {
      violations.push({
        file,
        line: index + 1,
        rule: "public workflow uses pull_request_target",
        text: line.trim(),
      });
    }
    if (/\bpermissions\s*:\s*write-all\b/.test(line)) {
      violations.push({
        file,
        line: index + 1,
        rule: "public workflow requests write-all permissions",
        text: line.trim(),
      });
    }
  }
  return violations;
}

function checkRequiredFiles() {
  const required = [
    "LICENSE",
    "NOTICE.md",
    "THIRD-PARTY-NOTICES.md",
    "README.md",
    "README.en.md",
    "CONTRIBUTING.md",
    "SECURITY.md",
    "CODE_OF_CONDUCT.md",
    "docs/README.md",
    "docs/contracts/performance-telemetry-catalog.md",
    "docs/contracts/process-resource-telemetry.md",
    "docs/testing/conversation-session-docker-automation.md",
  ];
  return required.filter((file) => !existsSync(join(ROOT, file))).map((file) => ({
    file,
    line: 0,
    rule: "required public file is missing",
    text: file,
  }));
}

function checkKeyFiles(trackedFiles, violations) {
  for (const file of trackedFiles) {
    const extension = extname(file).toLowerCase();
    let containsPrivateKey = BINARY_KEY_EXTENSIONS.has(extension);
    if (!containsPrivateKey && [".pem", ".crt", ".cer"].includes(extension)) {
      let content;
      try {
        content = readFileSync(join(ROOT, file), "utf8");
      } catch {
        continue;
      }
      containsPrivateKey = /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/.test(content);
    }
    if (!containsPrivateKey) continue;
    const isAllowedFixture =
      ALLOWED_PRIVATE_KEY_FILES.has(file) && file.includes("/tests/fixtures/");
    if (isAllowedFixture) continue;
    violations.push({
      file,
      line: 0,
      rule: "key material must not be committed",
      text: file,
    });
  }
}

function checkCuaBoundary(violations) {
  const manifestPath = "packages/zcode-cua/package.json";
  if (!existsSync(join(ROOT, manifestPath))) {
    violations.push({
      file: manifestPath,
      line: 0,
      rule: "CUA placeholder package is missing",
      text: manifestPath,
    });
    return;
  }
  const manifest = JSON.parse(readFileSync(join(ROOT, manifestPath), "utf8"));
  if (manifest.zcodeCuaPlaceholder !== true) {
    violations.push({
      file: manifestPath,
      line: 0,
      rule: "CUA package must declare zcodeCuaPlaceholder: true",
      text: "zcodeCuaPlaceholder",
    });
  }
  for (const directory of ["helper", "runtime", "engine", "vendor"]) {
    if (existsSync(join(ROOT, "packages/zcode-cua", directory))) {
      violations.push({
        file: `packages/zcode-cua/${directory}`,
        line: 0,
        rule: "private CUA implementation directory must not be public",
        text: directory,
      });
    }
  }
}

function main() {
  const trackedFiles = listTrackedFiles();
  const files = trackedFiles.filter(isTextFile);
  const violations = [];
  let scanned = 0;

  for (const file of files) {
    let content;
    try {
      content = readFileSync(join(ROOT, file), "utf8");
    } catch {
      continue;
    }
    scanned += 1;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (isAllowed(line)) continue;
      for (const rule of RULES) {
        if (
          rule.name === "internal document directory" &&
          (!file.endsWith(".md") || file.startsWith("apps/zcode-cli/packages/superpowers-plugin/"))
        ) {
          continue;
        }
        if (rule.re.test(line)) {
          violations.push({
            file,
            line: index + 1,
            rule: rule.name,
            text: line.trim().slice(0, 200),
          });
          break;
        }
      }
    }
    violations.push(...scanWorkflowShape(file, lines));
  }

  violations.push(...checkRequiredFiles());
  checkKeyFiles(trackedFiles, violations);
  checkCuaBoundary(violations);

  const unique = [];
  const seen = new Set();
  for (const violation of violations) {
    const key = `${violation.file}:${violation.line}:${violation.rule}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(violation);
    }
  }

  if (unique.length === 0) {
    console.log(`[public-repo] OK: scanned ${scanned} text files, no policy violations.`);
    return;
  }

  console.error(`[public-repo] FAILED: ${unique.length} violation(s) in ${scanned} files.\n`);
  for (const violation of unique.slice(0, 80)) {
    const location = violation.line ? `${violation.file}:${violation.line}` : violation.file;
    console.error(`- ${location} [${violation.rule}]`);
    if (violation.text) console.error(`    ${violation.text}`);
  }
  if (unique.length > 80) {
    console.error(`\n... and ${unique.length - 80} more.`);
  }
  console.error(
    "\nRemove private infrastructure, credentials, internal paths, or unpinned actions before committing.",
  );
  process.exitCode = 1;
}

main();
