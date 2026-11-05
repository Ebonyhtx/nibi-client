#!/usr/bin/env node
// 把上游的模型/Provider 配置同步成 NIBI 的 Built-in Provider 配置（默认 dry-run）。
//
// 背景：
// - 客户端运行时读两跳端点（`/api/v1/client/configs` → 签名 release），按 revision 更新；
//   这里生成的是**随包源** `config/provider/nibi-builtin*.json`，也是发布到服务端的同一份内容。
// - 除上游 **ZAI/BigModel 的会员套餐**（Coding Plan / Start / 闲置 / 高速卡）外，模板、模型、
//   站点规则全部跟随上游；不维护 NIBI 自己的模板白名单或逐模型启停。
// - 上游 `zcode.z.ai` 套餐站点规则不导入（NIBI 没有这些套餐）。
//
// 用法：
//   node scripts/sync-upstream-provider-config.mjs --from <release.json|https://...>        # dry-run
//   node scripts/sync-upstream-provider-config.mjs --from ... --write                      # 写回两份随包配置
//   node scripts/sync-upstream-provider-config.mjs --from ... --revision 35 --write
//   node scripts/sync-upstream-provider-config.mjs --from <client/configs 端点> --proxy http://127.0.0.1:7897
//
// 不处理 Rust 内核的随包副本（`kernel/crates/platform/assets/nibi-builtin.json`）：它按 vendor
// 升级走，形状也不同；需要 Rust 独立 CLI/TUI 看到新模型时另开一次内核发布。

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const repositoryRoot = resolve(import.meta.dirname, "..");
const PROD_PATH = "config/provider/nibi-builtin.json";
const TEST_PATH = "config/provider/nibi-builtin.test.json";

function parseArgs(argv) {
  const args = { addTemplates: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--from":
        args.from = argv[++index];
        break;
      case "--revision":
        args.revision = Number(argv[++index]);
        break;
      case "--proxy":
        args.proxy = argv[++index];
        break;
      case "--write":
        args.write = true;
        break;
      default:
        throw new Error(`unknown argument ${JSON.stringify(flag)}`);
    }
  }
  if (!args.from) throw new Error("missing --from <release.json|url>");
  return args;
}

async function readJson(url) {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return JSON.parse(await readFile(resolve(url), "utf8"));
  }
  const proxy = process.env.NIBI_SYNC_PROXY?.trim();
  let response;
  if (proxy) {
    const { ProxyAgent, fetch } = await import("undici");
    response = await fetch(url, { dispatcher: new ProxyAgent(proxy) });
  } else {
    response = await fetch(url);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} (${url})`);
  return JSON.parse(await response.text());
}

/**
 * `--from` 既可以是 release JSON，也可以是 `/api/v1/client/configs` 的响应；
 * 后者按契约读 `data.configs.builtin_provider_config_json` 再下第二跳。
 */
async function loadUpstreamRelease(from) {
  let value = await readJson(from);
  const pointer = value?.data?.configs?.builtin_provider_config_json;
  if (typeof pointer === "string") value = await readJson(pointer);
  if (!value || value.schemaVersion !== 1 || typeof value.config !== "object") {
    throw new Error("input is neither a NIBI built-in release nor a client/configs payload");
  }
  return value;
}

function templateIds(release) {
  return (release.config.providerConfigRules?.templateRules ?? []).map((rule) => rule.templateId);
}

function modelIds(release, templateId) {
  const template = (release.config.providerConfigRules?.templateRules ?? []).find(
    (rule) => rule.templateId === templateId,
  );
  return template?.config?.builtinModelIds ?? [];
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 上游 ZAI/BigModel 的会员套餐（Coding Plan / Start / 闲置 / 高速卡）不进入 NIBI。 */
function isZhipuMembershipRule(rule) {
  const access = rule?.config?.access;
  return access?.type === "zhipu-account" || access?.type === "zhipu-coding-plan-api-key";
}

function isZhipuMembershipProvider(providerId) {
  return typeof providerId === "string" && /^account:(?:zai|bigmodel)-/u.test(providerId);
}

function isUpstreamZcodeSiteRule(rule) {
  return typeof rule?.baseUrlMatch === "string" && /zcode/iu.test(rule.baseUrlMatch);
}

/**
 * 以上游 release 为内容源：除 ZAI/BigModel 会员套餐外，模板、模型、站点规则全部跟随上游。
 * 不再维护 NIBI 自己的模板白名单或逐模型启停；`currentTest` 里测试专属的
 * providerSiteRules 仍会保留（那是测试夹具，不是产品清单）。
 */
export function buildSyncedConfigs({ upstream, currentProd, currentTest, revision }) {
  const upstreamTemplates = upstream.config.providerConfigRules?.templateRules ?? [];
  const templates = upstreamTemplates.filter(
    (rule) => !isZhipuMembershipRule(rule) && !/^account:(?:zai|bigmodel)-/u.test(rule.templateId ?? ""),
  );
  const excludedTemplates = upstreamTemplates.filter((rule) => !templates.includes(rule));
  const keptIds = new Set(templates.map((rule) => rule.templateId));

  const upstreamModelRules = upstream.config.modelConfigRules ?? {};
  const templateModelRules = (upstreamModelRules.templateModelRules ?? []).filter((rule) =>
    keptIds.has(rule.templateId),
  );
  const siteRules = (upstreamModelRules.providerSiteRules ?? []).filter(
    (rule) => !isUpstreamZcodeSiteRule(rule),
  );
  const builtinProviderModelRules = (upstreamModelRules.builtinProviderModelRules ?? []).filter(
    (rule) => !isZhipuMembershipProvider(rule.providerId),
  );

  // Node 运行时合成 providerRules（随包源里是空数组）。
  const config = {
    ...upstream.config,
    providerConfigRules: {
      templateRules: templates,
      providerRules: [],
    },
    modelConfigRules: {
      ...upstreamModelRules,
      providerSiteRules: siteRules,
      templateModelRules,
      builtinProviderModelRules,
    },
  };

  // 测试档相对生产档多出的站点规则（测试夹具）继续保留。
  const prodSiteRules = currentProd.config.modelConfigRules?.providerSiteRules ?? [];
  const testSiteRules = currentTest.config.modelConfigRules?.providerSiteRules ?? [];
  const testOnlySiteRules = testSiteRules.filter(
    (rule) => !prodSiteRules.some((existing) => deepEqual(existing, rule)),
  );
  const testConfig = testOnlySiteRules.length
    ? {
        ...config,
        modelConfigRules: {
          ...config.modelConfigRules,
          providerSiteRules: [...(config.modelConfigRules.providerSiteRules ?? []), ...testOnlySiteRules],
        },
      }
    : config;

  const nextRevision = revision ?? Number(currentProd.revision) + 1;
  if (!Number.isInteger(nextRevision) || nextRevision < 1) {
    throw new Error(`invalid revision ${JSON.stringify(nextRevision)}`);
  }

  // NIBI 过去对个别模型的启停覆盖会被上游覆盖；报告出来，不静默丢弃。
  const currentOverrides = new Map(
    (currentProd.config.modelConfigRules?.templateModelRules ?? []).map((rule) => [
      `${rule.templateId}\u0000${rule.modelId}`,
      rule,
    ]),
  );
  const upstreamByKey = new Map(
    templateModelRules.map((rule) => [`${rule.templateId}\u0000${rule.modelId}`, rule]),
  );
  const droppedOverrides = [...currentOverrides.entries()]
    .filter(([key, rule]) => keptIds.has(rule.templateId) && !deepEqual(rule, upstreamByKey.get(key)))
    .map(([, rule]) => rule);

  return {
    prod: { schemaVersion: 1, revision: nextRevision, config },
    test: { schemaVersion: 1, revision: nextRevision, config: testConfig },
    upstreamRevision: upstream.revision,
    templates: {
      kept: [...keptIds],
      excluded: excludedTemplates.map((rule) => rule.templateId),
      // NIBI 当前随包、上游已移除的模板：同步会把它们删掉，dry-run 必须先看到。
      missingUpstream: templateIds(currentProd).filter((id) => !templateIds(upstream).includes(id)),
    },
    overridesDropped: droppedOverrides.length,
    modelChanges: [...keptIds].flatMap((id) => {
      const before = modelIds(currentProd, id);
      const after = modelIds(upstream, id);
      const added = after.filter((model) => !before.includes(model));
      const removed = before.filter((model) => !after.includes(model));
      return added.length || removed.length ? [{ templateId: id, added, removed }] : [];
    }),
  };
}

async function validateRelease(release) {
  const { decodeZCodeBuiltinRelease } = await tsImport(
    pathToFileURL(resolve(repositoryRoot, "packages/provider-node/src/nibi-builtin-release.ts")).href,
    import.meta.url,
  );
  decodeZCodeBuiltinRelease(release);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [currentProd, currentTest] = await Promise.all(
    [PROD_PATH, TEST_PATH].map(async (path) =>
      JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8")),
    ),
  );
  const upstream = await loadUpstreamRelease(args.from);
  // 不校验上游原样：它可能带着 NIBI 已删除的字段（例如套餐 access.mode）。
  // 过滤后的两份配置才是我们的契约，必须过 decodeZCodeBuiltinRelease。
  const result = buildSyncedConfigs({
    upstream,
    currentProd,
    currentTest,
    revision: args.revision,
  });
  await validateRelease(result.prod);
  await validateRelease(result.test);

  process.stdout.write(
    `${JSON.stringify(
      {
        from: args.from,
        upstreamRevision: result.upstreamRevision,
        nextRevision: result.prod.revision,
        templatesKept: result.templates.kept.length,
        templatesExcluded: result.templates.excluded,
        currentTemplatesMissingUpstream: result.templates.missingUpstream,
        nibiOverridesDropped: result.overridesDropped,
        modelChanges: result.modelChanges,
        wrote: args.write === true,
      },
      null,
      2,
    )}\n`,
  );

  if (!args.write) {
    process.stdout.write("[dry-run] pass --write to update the bundled configs\n");
    return;
  }
  for (const [path, release] of [
    [PROD_PATH, result.prod],
    [TEST_PATH, result.test],
  ]) {
    await writeFile(resolve(repositoryRoot, path), `${JSON.stringify(release, null, 2)}\n`, "utf8");
  }
  process.stdout.write(`updated ${PROD_PATH} and ${TEST_PATH} (revision ${result.prod.revision})\n`);
  process.stdout.write(
    "Rust bundled asset unchanged: kernel/crates/platform/assets/nibi-builtin.json needs its own release.\n",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[sync-upstream-provider-config] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
