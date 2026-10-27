#!/usr/bin/env node
/**
 * 直接验证"自定义命令能否被解析 + 展开"，不跑模型、不依赖 UI。
 *
 * 用宿主的真实 loader（@nibi/bootstrap）分别走两条路径：
 *   ① `loadZCodeCustomCommand`（命令行探测用的那一半）
 *   ② `expandCustomCommandPrompt`（facade 展开用的那一半）
 * 两者都成功 = 展开链路本身是好的，问题在别处；任一步失败 = 就是它。
 *
 * 用法：node scripts/verify-command-resolution.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
// 直接用 tsx 跑源码：这两个包的 exports 只声明了 import 条件，编译产物之间
// 还有 TS 的 .js 说明符映射，用 tsx 一次性解决。
const bootstrap = await import(
  pathToFileURL(join(repoRoot, "apps/zcode-cli/packages/bootstrap/src/index.ts")).href
);
const contracts = await import(
  pathToFileURL(join(repoRoot, "apps/zcode-cli/packages/contracts/src/index.ts")).href
);

const MARKER = "RESOLVE-MARKER-4b71";
const workRoot = mkdtempSync(join(tmpdir(), "nibi-command-resolve-"));
const dataRoot = join(workRoot, "iso-root");
const workspace = join(workRoot, "workspace");
const commandsDir = join(workspace, ".nibi", "commands");
mkdirSync(commandsDir, { recursive: true });
writeFileSync(
  join(commandsDir, "resolve-probe.md"),
  ["---", "description: 解析取证", "---", "", `正文标记 ${MARKER}`, "参数：$ARGUMENTS", ""].join("\n"),
  "utf8",
);

const env = {
  ...process.env,
  NIBI_DATA_BASE_DIR: dataRoot,
  NIBI_STORAGE_DIR: dataRoot,
};
const logger = { debug() {}, error() {}, info() {}, warn() {} };

console.log(`workspace=${workspace}`);
console.log(`exports: ${Object.keys(bootstrap).filter((key) => /command/i.test(key)).join(", ")}`);

let loaded;
try {
  loaded = await bootstrap.loadZCodeCustomCommand({
    env,
    logger,
    name: "resolve-probe",
    workingDirectory: workspace,
  });
  console.log(`\n① loadZCodeCustomCommand：成功\n${JSON.stringify({
    description: loaded?.description,
    name: loaded?.name,
    bodyChars: String(loaded?.body ?? "").length,
  })}`);
} catch (error) {
  console.log(`\n① loadZCodeCustomCommand：**失败** ${error?.message}`);
}

if (loaded) {
  try {
    const expanded = contracts.expandCustomCommandPrompt({ args: "hello-arg", command: loaded });
    console.log(
      `\n② expandCustomCommandPrompt：成功，标记出现=${expanded.prompt.includes(MARKER)}，长度=${expanded.prompt.length}`,
    );
    console.log(`展开结果前 300 字：\n${expanded.prompt.slice(0, 300)}`);
  } catch (error) {
    console.log(`\n② expandCustomCommandPrompt：**失败** ${error?.message}`);
  }
}

rmSync(workRoot, { recursive: true, force: true });
