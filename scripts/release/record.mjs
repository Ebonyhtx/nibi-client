#!/usr/bin/env node
// pnpm release:record --artifact <id> --stage built|published|verified
//
// built 可以离线记录（例如 CI 已出候选包但还没上传）；published/verified 会先做
// 与 release:verify 相同的远端校验，避免把“以为发了”写进台账。

import {
  artifactRecord,
  latestMarketplaceBaseline,
  loadManifest,
  readLedger,
  readProjectVersion,
  recordStage,
  REPO_ROOT,
  writeLedger,
} from "./core.mjs";
import { checkArtifact } from "./checks.mjs";

const USAGE = `用法：node scripts/release/record.mjs --artifact <id> --stage built|published|verified [选项]

  --artifact <id>   产物 id（见 release-manifest.json）
  --stage <stage>   built / published / verified
  --note <text>     证据或备注（推荐写 CI run / 发布单号）
  --revision <n>    插件市场 revision（plugin-market 的 published/verified 必填）
  --root <repo>     仓库根目录
  --json            输出机器可读结果`;

function parseArgs(argv) {
  const args = { root: REPO_ROOT, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--artifact":
        args.artifact = argv[++index];
        break;
      case "--stage":
        args.stage = argv[++index];
        break;
      case "--note":
        args.note = argv[++index];
        break;
      case "--revision":
        args.revision = Number(argv[++index]);
        break;
      case "--root":
        args.root = argv[++index];
        break;
      case "--json":
        args.json = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`未知参数：${flag}`);
    }
  }
  if (args.help) return args;
  if (!args.artifact) throw new Error("缺少 --artifact");
  if (!args.stage) throw new Error("缺少 --stage");
  if (!["built", "published", "verified"].includes(args.stage)) {
    throw new Error(`--stage 只能是 built / published / verified：${args.stage}`);
  }
  if (args.revision !== undefined && !Number.isSafeInteger(args.revision)) {
    throw new Error("--revision 必须是整数");
  }
  if (args.root) args.root = String(args.root);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const manifest = await loadManifest(args.root);
  const artifact = manifest.artifacts.find((item) => item.id === args.artifact);
  if (!artifact) {
    throw new Error(
      `未知产物 ${args.artifact}；可选：${manifest.artifacts.map((item) => item.id).join(", ")}`,
    );
  }
  const version = await readProjectVersion(args.root);
  const ledger = await readLedger(args.root);

  let check = null;
  if (args.stage !== "built") {
    const baseline = latestMarketplaceBaseline(ledger);
    check = await checkArtifact(artifact, {
      version,
      ledger,
      baseline: artifact.check.kind === "plugin-market" ? baseline : undefined,
    });
    if (!check.valid) throw new Error(`远端校验失败：${check.detail}`);
    if (artifact.check.kind === "plugin-market") {
      if (check.revision < (baseline?.revision ?? 0)) {
        throw new Error(`拒绝登记市场回退：${check.revision} < ${baseline?.revision}`);
      }
      if (args.revision !== undefined && args.revision !== check.revision) {
        throw new Error(`--revision ${args.revision} 与线上 revision ${check.revision} 不一致`);
      }
      args.revision = check.revision;
    } else if (!check.current) {
      throw new Error(`产物尚未在线上完整可见，不能记为 ${args.stage}：${check.detail}`);
    }
  }

  const entry = recordStage(ledger, {
    version,
    artifactId: artifact.id,
    stage: args.stage,
    note: args.note,
    revision: args.revision,
    pluginVersion: check?.pluginVersion,
    checks: check ? [artifact.check.kind, "remote"] : ["local"],
  });
  await writeLedger(args.root, ledger);

  const previous = artifactRecord(ledger, version, artifact.id);
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({ version, artifact: artifact.id, stage: args.stage, entry, record: previous }, null, 2)}\n`,
    );
  } else {
    console.log(
      `已记录 ${artifact.label} (${artifact.id}) ${args.stage} @ ${version}：release/ledger.json`,
    );
    if (args.note) console.log(`备注：${args.note}`);
  }
}

main().catch((error) => {
  console.error(`[release:record] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
