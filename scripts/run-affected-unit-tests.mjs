#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createVitest } from "vitest/node";
import { git, cleanGitEnv } from "./affected-unit-tests/process.mjs";
import { resolveScope } from "./affected-unit-tests/scope.mjs";

export async function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--scope" || arg === "--base") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`${arg} 需要参数`);
      options[arg.slice(2)] = value;
    } else if (arg === "--files") {
      options.files ??= [];
      while (argv[i + 1] && !argv[i + 1].startsWith("--")) options.files.push(argv[++i]);
      if (!options.files.length) throw new Error("--files 需要文件清单");
    } else if (arg === "--package") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--package 需要参数");
      options.packages ??= [];
      options.packages.push(
        ...value
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean),
      );
      if (!options.packages.length) throw new Error("--package 需要参数");
    } else if (arg === "--files-manifest") {
      const manifest = argv[++i];
      if (!manifest) throw new Error("--files-manifest 需要路径");
      const parsed = JSON.parse(await readFile(manifest, "utf8"));
      if (
        !Array.isArray(parsed.files) ||
        !parsed.files.length ||
        !parsed.files.every((file) => typeof file === "string" && file)
      )
        throw new Error("文件清单无效");
      options.files = [...(options.files ?? []), ...parsed.files];
    } else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

const specKey = (spec) => JSON.stringify([spec.project.name, spec.pool, spec.moduleId]);

// Windows 上 Vitest 的 spec.moduleId 用正斜杠，而 related 依赖 path.join 生成反斜杠。
// 只给一份路径时，「改动的测试文件本身」永远匹配不上：--files 指向一个 test.ts
// 实测选中 0 个（判据空转）。补另一分隔符的变体，不改选择规则，也不放宽匹配范围。
const withPathVariants = (files) => {
  const variants = new Set(files);
  if (process.platform === "win32")
    for (const file of files) {
      variants.add(file.replaceAll("\\", "/"));
      variants.add(file.replaceAll("/", "\\"));
    }
  return [...variants];
};

// --package services / --package packages/services / --package apps/nibi-cli
const matchesPackage = (path, names) =>
  names.some((name) => {
    const normalized = name.replace(/^\.\//u, "").replace(/\/+$/u, "");
    return (
      path.startsWith(`${normalized}/`) ||
      (!normalized.includes("/") &&
        (path.startsWith(`packages/${normalized}/`) || path.startsWith(`apps/${normalized}/`)))
    );
  });

export async function main(argv = process.argv.slice(2)) {
  let vitest;
  const restored = {};
  try {
    const options = await parseArgs(argv);
    if (options.help) {
      console.log(
        "用法：pnpm test:unit:affected [--scope worktree|push] [--base <commit>] [--files <files...>] [--package <name>] [--dry-run] [--json]\n本地日常改动可用 pnpm test:unit:changed（等价于 --scope worktree，默认只比较 HEAD 与未提交改动）。\n--package <name[,name...]> 在官方选中结果里只保留指定包的测试（仅本地迭代用，不能与 --scope push 混用）。\n使用 Vitest 官方选择；全量选择默认按失败处理（先跑 pnpm test:unit，再带 NIBI_AFFECTED_UT_ACK=full 放行），脏工作区 Push 与错误非零退出。0=通过/无选中测试/已承认跳过全量，1=测试失败或全量选择未确认，2=阻止执行/脚本错误。",
      );
      return 0;
    }
    const root = (await git(process.cwd(), ["rev-parse", "--show-toplevel"])).toString().trim();
    const env = await cleanGitEnv(root);
    // hook 的临时 index 不能污染官方 Git 选择及测试中的临时仓库。
    for (const key of Object.keys(process.env)) {
      if (!(key in env)) {
        restored[key] = process.env[key];
        delete process.env[key];
      }
    }
    const scope = await resolveScope(root, options, env);
    const selected = new Map();
    const related = new Set();
    let all = [];
    const selectionStartedAt = Date.now();
    if (!scope.deletedOnly) {
      vitest = await createVitest(
        "test",
        { root, watch: false, run: true, reporters: ["default"], silent: "passed-only" },
        { server: { watch: null } },
      );
      all = await vitest.globTestSpecifications();
      for (const base of scope.bases) {
        // 用官方 VCS provider 取改动清单后交给官方 related 选择：语义与 config.changed
        // 完全一致，只是多了 Windows 路径分隔符变体。--scope worktree（test:unit:changed）
        // 也走这里，避免本地入口和 push 入口出现两套选择逻辑。
        const changedFiles =
          scope.files ?? (await vitest.vcs.findChangedFiles({ root, changedSince: base }));
        vitest.config.changed = false;
        vitest.config.related = withPathVariants(changedFiles);
        for (const spec of await vitest.getRelevantTestSpecifications())
          selected.set(specKey(spec), spec);
        for (const file of changedFiles) related.add(file);
      }
    }
    const selectionMs = Date.now() - selectionStartedAt;
    let specs = [...selected.values()].sort((a, b) => specKey(a).localeCompare(specKey(b)));
    // 只收窄「本地迭代」的执行集合：选择仍由官方完成，全量判定仍看未收窄的 selected。
    if (options.packages?.length) {
      const before = specs.length;
      specs = specs.filter((spec) =>
        matchesPackage(relative(root, spec.moduleId).replaceAll("\\", "/"), options.packages),
      );
      (options.json ? console.error : console.log)(
        `[affected] --package ${options.packages.join(",")}：${before} -> ${specs.length} 个文件（仅本地迭代；门禁仍以官方选中集合为准）`,
      );
    }
    const tests = specs.map((spec) => ({
      runner: "vitest",
      project: spec.project.name,
      pool: spec.pool,
      path: relative(root, spec.moduleId).replaceAll("\\", "/"),
    }));
    if (options.json) console.log(JSON.stringify(tests, null, 2));
    else {
      console.log(
        `[affected] base=${scope.files ? "related" : scope.bases.map((base) => (base === true ? "HEAD（未提交）" : base)).join(",")} 选中 ${specs.length}/${all.length}${specs.length ? "" : "：无选中测试"}（选择耗时 ${(selectionMs / 1000).toFixed(1)}s）`,
      );
      if (options.dryRun)
        for (const test of tests) console.log(`  ${test.project}/${test.pool}: ${test.path}`);
    }
    // 0 个选中时以前只打印一行并 exit 0，长报告的读者很容易把它当成「已跑过」。
    // 独立提示，并明确这不代表改动已验证；删除 ref 的 push 不提示。
    if (!specs.length && !scope.deletedOnly)
      console.warn("[affected] 未选中任何测试（判据空转）：本轮没有执行 UT，不代表改动已验证。");
    // 全量选择 = 影响面裁剪失效：改动面覆盖了每一个规格，等于「不知道该跑什么」。
    //
    // 以前这里直接 `return 0` 并打印「不因此阻止 Push」。结果是**改动越大、这道闸越等于没有**：
    // 一次跨包的品牌化改动让 1929 个规格全部入选，然后什么都没跑就放行了（实测过）。
    // 现在默认按**失败**处理，把选择权交回给人：
    //   - 真跑了全量：`pnpm test:unit`，然后带 `NIBI_AFFECTED_UT_ACK=full` 重试；
    //   - 只是想过闸：必须显式给这个变量——那是一次有意识的承认，不是静默放行。
    if (all.length && all.every((spec) => selected.has(specKey(spec)))) {
      const acknowledged = (process.env.NIBI_AFFECTED_UT_ACK ?? "").trim().toLowerCase();
      if (acknowledged === "full" || acknowledged === "1" || acknowledged === "true") {
        console.warn(
          `[affected] 影响面覆盖了全部 ${all.length} 个规格，已按 NIBI_AFFECTED_UT_ACK=${acknowledged} 放行——这一轮 UT 没有由本脚本执行。`,
        );
        return 0;
      }
      console.error(
        `[affected] 改动面覆盖了全部 ${all.length} 个规格，按影响面裁剪失效：脚本不会替你跑全量，也不假装跑过。`,
      );
      console.error(
        "[affected] 先跑 `pnpm test:unit`；确认通过后再带 `NIBI_AFFECTED_UT_ACK=full` 重跑本脚本放行。",
      );
      console.error(
        `[affected] 改动文件：${[...related].map((file) => relative(root, file)).join(", ")}`,
      );
      return 1;
    }
    if (!specs.length || options.dryRun) return 0;
    await vitest.standalone();
    const runStartedAt = Date.now();
    const result = await vitest.runTestSpecifications(specs, false);
    console.log(
      `[affected] 执行 ${specs.length} 个文件，耗时 ${((Date.now() - runStartedAt) / 1000).toFixed(1)}s`,
    );
    return result.unhandledErrors.length ||
      result.testModules.some((module) => module.state() === "failed")
      ? 1
      : 0;
  } catch (error) {
    console.error(`[affected] ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  } finally {
    try {
      await vitest?.close();
    } finally {
      Object.assign(process.env, restored);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  process.exitCode = await main();
