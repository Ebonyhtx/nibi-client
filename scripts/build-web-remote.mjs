#!/usr/bin/env node
// 构建手机远控 SPA（web-remote）。
//
// 为什么不用 `vite build --base=/remote/v4/`：Windows Git Bash 会把 POSIX 参数改写成
// `C:/Program Files/Git/remote/v4/`，产物里的 JS/CSS 全部 404（4.1.1 的真实事故）。
// 这里改为设置 NIBI_WEB_BASE 环境变量（不经过 MSYS 路径转换），并在构建后自检：
// 页面里不得出现本机路径，所有根相对资源必须落在 /remote/v4/ 下且文件真实存在。
//
//   node scripts/build-web-remote.mjs             # 构建 + 自检
//   node scripts/build-web-remote.mjs --check-only # 只自检现有 dist

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(REPO_ROOT, "packages/web/dist");
const checkOnly = process.argv.includes("--check-only");
const BASE = process.argv.includes("--test") ? "/remote/__test__/" : "/remote/v4/";

function fail(message) {
  console.error(`[build:web-remote] ${message}`);
  process.exitCode = 1;
}

async function verifyDist() {
  const indexPath = join(DIST, "index.html");
  if (!existsSync(indexPath)) {
    fail(`缺少构建产物：${indexPath}`);
    return;
  }
  const html = await readFile(indexPath, "utf8");

  const machinePathPatterns = [
    { name: "Git Bash 改写路径", pattern: /\/Program Files\/Git\//iu },
    { name: "Windows 盘符路径", pattern: /\b[A-Za-z]:[\\/]/u },
    { name: "file:// 本机路径", pattern: /file:\/\//iu },
  ];
  for (const { name, pattern } of machinePathPatterns) {
    if (pattern.test(html)) fail(`index.html 含${name}，构建参数被本机环境改写`);
  }

  const rootRelative = [];
  for (const match of html.matchAll(/\b(?:src|href)="([^"]+)"/giu)) {
    const value = match[1];
    if (/^(?:data:|https?:|#)/iu.test(value)) continue;
    if (value.startsWith("/")) rootRelative.push(value);
  }
  if (rootRelative.length === 0) fail("index.html 没有根相对资源，构建异常");
  for (const value of rootRelative) {
    if (!value.startsWith(BASE)) {
      fail(`资源 ${value} 不在 ${BASE} 前缀下`);
      continue;
    }
    const relative = value.slice(BASE.length).split(/[?#]/u)[0];
    if (relative && !existsSync(join(DIST, relative))) {
      fail(`资源 ${value} 在 dist 里不存在`);
    }
  }

  const releasePath = join(DIST, "release.json");
  if (!existsSync(releasePath)) {
    fail("缺少 release.json");
  } else {
    const release = JSON.parse(await readFile(releasePath, "utf8"));
    const pkg = JSON.parse(await readFile(join(REPO_ROOT, "package.json"), "utf8"));
    if (release.version !== pkg.version) {
      fail(`release.json 版本 ${release.version} 与 package.json ${pkg.version} 不一致`);
    }
  }

  const maps = (await readdir(DIST, { recursive: true })).filter((name) => name.endsWith(".map"));
  if (maps.length > 0) {
    fail(`dist 里有 ${maps.length} 个 source map；NIBI_WEB_SOURCEMAP=off 没有生效`);
  }

  if (process.exitCode !== 1) {
    console.log(`[build:web-remote] 自检通过：${rootRelative.length} 个根相对资源都在 ${BASE} 下。`);
  }
}

function runBuild() {
  const env = {
    ...process.env,
    NIBI_ENV: process.env.NIBI_ENV?.trim() || "production",
    NIBI_WEB_BASE: BASE,
    NIBI_WEB_SOURCEMAP: "off",
  };
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  return new Promise((resolvePromise) => {
    const child = spawn(command, ["--filter", "@nibi/web", "exec", "vite", "build"], {
      cwd: REPO_ROOT,
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    child.on("exit", (code) => resolvePromise(code ?? 1));
    child.on("error", (error) => {
      console.error(`[build:web-remote] 启动构建失败：${error.message}`);
      resolvePromise(1);
    });
  });
}

if (!checkOnly) {
  const code = await runBuild();
  if (code !== 0) process.exit(code);
}
await verifyDist();
if (process.exitCode === 1) process.exit(1);