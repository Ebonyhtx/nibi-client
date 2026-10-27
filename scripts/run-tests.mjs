#!/usr/bin/env node
// 逐包跑测试。
//
// 为什么不放在一条 node --test 里：UI 包用 `@/*` 路径别名（packages/ui/tsconfig.json），
// 而 tsx 的 tsconfig 解析是按进程来的——单进程跑所有包时，UI 的别名声明的解析规则
// 和其余包的相对导入无法同时满足，UI 测试会以 ERR_MODULE_NOT_FOUND(@/lib) 挂掉。
// 这里按包分组、各自带自己的 tsconfig 与工作目录起进程，隔离掉这个差异。
//
// 用法：
//   node scripts/run-tests.mjs            # 全部
//   node scripts/run-tests.mjs goal       # 只跑路径含 "goal" 的测试文件
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const filters = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const PACKAGE_ROOTS = ["packages", "apps/zcode-cli/packages"];
const TEST_SUFFIXES = [".test.ts", ".test.mts", ".test.js", ".test.mjs"];

function collectTestFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      found.push(...collectTestFiles(full));
    } else if (TEST_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      found.push(full);
    }
  }
  return found.sort();
}

function discoverGroups() {
  const groups = [];
  for (const base of PACKAGE_ROOTS) {
    const baseDir = join(root, base);
    if (!existsSync(baseDir)) continue;
    for (const name of readdirSync(baseDir).sort()) {
      const packageDir = join(baseDir, name);
      const testDir = join(packageDir, "test");
      if (!existsSync(testDir) || !statSync(testDir).isDirectory()) continue;
      const files = collectTestFiles(testDir).filter(
        (file) => filters.length === 0 || filters.some((f) => file.includes(f)),
      );
      if (files.length > 0) groups.push({ files, packageDir, testDir });
    }
  }
  return groups;
}

const groups = discoverGroups();
if (groups.length === 0) {
  console.error("No test files found.");
  process.exit(1);
}

let failed = 0;
let totalFiles = 0;
for (const group of groups) {
  const label = relative(root, group.packageDir).split(sep).join("/");
  const tsconfig = join(group.packageDir, "tsconfig.json");
  console.log(`\n=== ${label} (${group.files.length} file(s)) ===`);
  totalFiles += group.files.length;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", ...group.files],
    {
      cwd: group.packageDir,
      env: {
        ...process.env,
        ...(existsSync(tsconfig) ? { TSX_TSCONFIG_PATH: tsconfig } : {}),
      },
      stdio: "inherit",
    },
  );
  if (result.status !== 0) failed += 1;
}

if (failed > 0) {
  console.error(`\n${failed} test group(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${groups.length} test group(s) passed (${totalFiles} file(s)).`);
