#!/usr/bin/env node
// 根 typecheck 入口。
//
// 旧命令是 `tsc -b <15 个工程> && tsc -p a && tsc -p b && ...`：
// - `tsc -b` 已经是增量的，热缓存下约 2-5s；
// - 后面 5 个 `tsc -p --noEmit` 彼此独立，却串行执行，实测合计约 10.7s。
// 这里只把并行度提上来，工程集合、参数、退出语义与旧命令完全一致：
// 仍然检查同样的 20 个工程，不合并、不跳过、不加 `--bail`。
//
// 用法：
//   pnpm typecheck                         # tsc -b 后并行检查 5 个 noEmit 工程
//   node scripts/typecheck.mjs --concurrency 2
//   TYPECHECK_CONCURRENCY=1 pnpm typecheck # 低内存机器退回串行
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tscBin = join(root, "node_modules", "typescript", "bin", "tsc");

const buildProjects = [
  "packages/shared/tsconfig.testing.json",
  "packages/rpc",
  "packages/provider",
  "packages/provider-node",
  "packages/shared",
  "packages/services",
  "packages/client",
  "packages/server",
  "packages/nibi-server-cli",
  "packages/ui",
  "packages/web",
  "apps/dev-docs",
  "packages/e2e-report",
  "packages/desktop/tsconfig.main.json",
  "packages/desktop/tsconfig.host.json",
  "packages/desktop/tsconfig.e2e.json",
];

// 与旧 `typecheck` 里的 5 条 `tsc -p ...` 一一对应，顺序也保持原样。
const standaloneProjects = [
  "packages/desktop/tsconfig.remote-main.json",
  "packages/zcode-cua",
  "packages/desktop/tsconfig.renderer.json",
  "packages/desktop/tsconfig.preload.json",
  "packages/desktop/tsconfig.scripts.json",
];

function parseConcurrency(argv) {
  let value = process.env.TYPECHECK_CONCURRENCY;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--concurrency") {
      value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--concurrency 需要数字");
    } else if (arg.startsWith("--concurrency=")) {
      value = arg.slice("--concurrency=".length);
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "用法：node scripts/typecheck.mjs [--concurrency <n>]\n先跑 tsc -b（增量），再并行检查 5 个独立 noEmit 工程；工程集合与 pnpm typecheck 旧命令一致。",
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (value === undefined || value === "") {
    // 4 核机器并发 2、8 核及以上并发 4：既能压掉串行尾巴，又不在低配机上同时开 5 个 tsc。
    return Math.max(1, Math.min(4, Math.floor(cpus().length / 2)));
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`--concurrency 需要正整数，收到：${value}`);
  return Math.min(parsed, standaloneProjects.length);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function runProject(project) {
  return new Promise((done) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [tscBin, "-p", project, "--noEmit"], {
      cwd: root,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", (error) => {
      done({ project, code: 1, ms: Date.now() - startedAt, output: String(error) });
    });
    child.on("close", (code) => {
      done({ project, code: code ?? 1, ms: Date.now() - startedAt, output });
    });
  });
}

async function runConcurrent(projects, concurrency) {
  const results = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, projects.length) }, async () => {
    while (next < projects.length) {
      const project = projects[next++];
      const result = await runProject(project);
      results.push(result);
      console.log(
        `[typecheck] ${result.code === 0 ? "✓" : "✗"} ${project} ${(result.ms / 1000).toFixed(1)}s`,
      );
      // 让出事件循环，避免多个 close 回调在同一个 tick 里连续打印。
      await sleep(0);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main(argv = process.argv.slice(2)) {
  if (!existsSync(tscBin)) {
    console.error(`[typecheck] 找不到 TypeScript：${tscBin}（先 pnpm install）`);
    return 2;
  }
  let concurrency;
  try {
    concurrency = parseConcurrency(argv);
  } catch (error) {
    console.error(`[typecheck] ${error.message}`);
    return 2;
  }

  const totalStartedAt = Date.now();
  const buildStartedAt = Date.now();
  const build = spawnSync(process.execPath, [tscBin, "-b", ...buildProjects], {
    cwd: root,
    stdio: "inherit",
  });
  const buildMs = Date.now() - buildStartedAt;
  if (build.error) {
    console.error(`[typecheck] tsc -b 启动失败：${build.error.message}`);
    return 2;
  }
  if (build.status !== 0) {
    console.error(
      `[typecheck] tsc -b 失败（${(buildMs / 1000).toFixed(1)}s），不再执行独立工程检查。`,
    );
    return build.status ?? 1;
  }
  console.log(`[typecheck] tsc -b ${buildProjects.length} 个工程：${(buildMs / 1000).toFixed(1)}s`);

  const standaloneStartedAt = Date.now();
  const results = await runConcurrent(standaloneProjects, concurrency);
  const standaloneMs = Date.now() - standaloneStartedAt;
  const failed = results.filter((result) => result.code !== 0);
  if (failed.length) {
    for (const result of failed) {
      console.error(`\n[typecheck] ${result.project} 失败：`);
      if (result.output.trim()) console.error(result.output.trimEnd());
    }
    console.error(
      `\n[typecheck] ${failed.length}/${standaloneProjects.length} 个独立工程失败（并行 ${(standaloneMs / 1000).toFixed(1)}s）。`,
    );
    return 1;
  }
  console.log(
    `[typecheck] ${standaloneProjects.length} 个独立工程并行检查（并发 ${Math.min(concurrency, standaloneProjects.length)}）：${(standaloneMs / 1000).toFixed(1)}s`,
  );
  console.log(`[typecheck] 通过，总计 ${((Date.now() - totalStartedAt) / 1000).toFixed(1)}s`);
  return 0;
}

process.exitCode = await main();
