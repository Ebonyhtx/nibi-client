#!/usr/bin/env node
// pnpm release:verify
//
// 发布闸门：当前版本需要的产物必须全部在远端完整可见；插件市场目录必须健康。
// 只读；加 --record 才在全部通过后把 published/verified 写进 release/ledger.json。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
import {
  buildGithubReleaseBody,
  fetchGithubRelease,
  normalizeReleaseBody,
  releaseTag,
  releaseTitle,
  validateChangelog,
} from "./release-notes-core.mjs";

const USAGE = `用法：node scripts/release/verify.mjs [--record] [--deep] [--json] [--root <repo>]

  --record  全部通过后把 published/verified 写进 release/ledger.json
  --deep    Source Server 额外下载全部 archive 并校验 sha256（慢、耗流量）
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

async function checkReleaseNotes(root, version) {
  const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
  const { entries, violations } = validateChangelog(changelog, { currentVersion: version });
  if (violations.length > 0) {
    return { valid: false, detail: `CHANGELOG 不符合用户口径：${violations[0]}` };
  }
  let release;
  try {
    release = await fetchGithubRelease(version);
  } catch (error) {
    return { valid: false, detail: error instanceof Error ? error.message : String(error) };
  }
  if (!release) {
    return { valid: false, detail: `GitHub 上还没有 ${releaseTag(version)} 的 Release 页` };
  }
  if (release.name !== releaseTitle(version)) {
    return { valid: false, detail: `Release 标题应为 “${releaseTitle(version)}”` };
  }
  const expected = normalizeReleaseBody(buildGithubReleaseBody(entries[0]));
  if (normalizeReleaseBody(String(release.body ?? "")) !== expected) {
    return {
      valid: false,
      detail: "Release 正文与 CHANGELOG 不同源；运行 pnpm release:notes:publish 覆盖",
    };
  }
  return { valid: true, detail: `GitHub Release ${releaseTag(version)} 与 CHANGELOG 同源` };
}

function releaseNotesArtifact(notes) {
  return {
    id: "release-notes",
    label: "GitHub Release 说明",
    required: true,
    changedFiles: 1,
    status: notes.valid ? "ready" : "missing",
    detail: notes.detail,
    stage: { built: true, published: notes.valid, verified: notes.valid },
    remote: {
      kind: "release-notes",
      valid: notes.valid,
      current: notes.valid,
      present: notes.valid ? 1 : 0,
      total: 1,
    },
    evidence: null,
    blocksVerify: !notes.valid,
  };
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

  const notes = await checkReleaseNotes(args.root, version);
  status.artifacts.unshift(releaseNotesArtifact(notes));
  status.summary.required += 1;
  if (notes.valid) status.summary.ready += 1;
  else {
    status.summary.missing += 1;
    status.summary.blocking += 1;
  }
  status.ok = status.summary.blocking === 0;

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
