#!/usr/bin/env node
// pnpm release:verify
//
// 发布闸门：当前版本需要的产物必须全部在远端完整可见；插件市场目录必须健康。
// 只读；加 --record 才在全部通过后把 published/verified 写进 release/ledger.json。

import {
  buildReleaseStatus,
  collectChangedFiles,
  hasTag,
  latestMarketplaceBaseline,
  loadManifest,
  parseCommonArgs,
  readLastTag,
  readLedger,
  readPreviousTag,
  readProjectVersion,
  recordStage,
  statusToJson,
  writeLedger,
} from "./core.mjs";
import { checkArtifact } from "./checks.mjs";

const USAGE = `用法：node scripts/release/verify.mjs [--record] [--deep] [--json] [--root <repo>]

  --record  全部通过后把 published/verified 写进 release/ledger.json
  --deep    Source Server 额外下载四个 archive 并校验 sha256（慢、耗流量）
  --json    输出机器可读结果
  --root    仓库根目录（默认当前仓库）

任一需要发布的产物未完整出现在线上，命令退出码为 1。`;

function printText(status, recordedPath) {
  console.log(`发布校验 ${status.version}（上一发布标签 ${status.lastTag ?? "无"}）`);
  console.log("");
  for (const artifact of status.artifacts) {
    const mark =
      artifact.status === "ready"
        ? "OK"
        : artifact.blocksVerify
          ? artifact.status.toUpperCase()
          : "WARN";
    const required = artifact.required ? "需要发布" : "无需更新";
    console.log(`[${mark}] ${artifact.label} — ${required} — ${artifact.detail}`);
  }
  console.log("");
  console.log(
    `汇总：pending ${status.summary.pending} / ready ${status.summary.ready} / missing ${status.summary.missing}`,
  );
  if (status.warnings.length > 0) {
    for (const warning of status.warnings) console.log(`提示：${warning}`);
  }
  if (status.ok) {
    console.log("通过：当前版本没有缺件。");
    if (recordedPath) console.log(`台账已记录：${recordedPath}`);
  } else {
    console.log("失败：仍有产物未完成。没有发布任何东西。");
  }
}

async function main() {
  const args = parseCommonArgs(process.argv.slice(2), { allowRecord: true, allowDeep: true });
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const manifest = await loadManifest(args.root);
  const version = await readProjectVersion(args.root);
  const lastTag = await readLastTag(args.root, manifest.tagPrefix);
  const currentTag = `${manifest.tagPrefix}${version}`;
  const tagged = await hasTag(args.root, currentTag);
  const releaseBaselineTag = tagged
    ? await readPreviousTag(args.root, manifest.tagPrefix, version)
    : lastTag;
  const changedFiles = await collectChangedFiles(args.root, releaseBaselineTag);
  const changedAfterTag = tagged ? await collectChangedFiles(args.root, currentTag) : [];
  const ledger = await readLedger(args.root);
  const baseline = latestMarketplaceBaseline(ledger);

  const checks = {};
  await Promise.all(
    manifest.artifacts.map(async (artifact) => {
      checks[artifact.id] = await checkArtifact(artifact, {
        version,
        ledger,
        baseline: artifact.check.kind === "plugin-market" ? baseline : undefined,
        deep: args.deep,
      });
    }),
  );

  const status = buildReleaseStatus({
    manifest,
    version,
    lastTag,
    releaseBaselineTag,
    tagged,
    changedFiles,
    changedAfterTag,
    ledger,
    checks,
  });

  let recordedPath = null;
  if (args.record && status.ok) {
    for (const artifact of manifest.artifacts) {
      const check = checks[artifact.id];
      const marketReady =
        artifact.check.kind === "plugin-market" &&
        Number.isSafeInteger(check?.revision) &&
        check.revision >= (baseline?.revision ?? 0);
      if (!check?.valid || (!check.current && !marketReady)) continue;
      const common = {
        version,
        artifactId: artifact.id,
        note: "release:verify --record",
        checks: [artifact.check.kind, "remote"],
      };
      recordStage(ledger, { ...common, stage: "published" });
      recordStage(ledger, {
        ...common,
        stage: "verified",
        revision: check.revision,
        pluginVersion: check.pluginVersion,
      });
    }
    await writeLedger(args.root, ledger);
    recordedPath = "release/ledger.json";
  }

  if (args.json) {
    process.stdout.write(statusToJson(status));
  } else {
    printText(status, recordedPath);
  }
  if (!status.ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`[release:verify] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
