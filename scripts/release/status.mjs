#!/usr/bin/env node
// pnpm release:status
//
// 只读：把“当前版本、上一发布标签、改动面、每个产物的线上状态”打出来。
// 不发包、不写台账、不改远端。

import {
  buildReleaseStatus,
  collectChangedFiles,
  formatStatusMarkdown,
  formatStatusText,
  hasTag,
  latestMarketplaceBaseline,
  loadManifest,
  parseCommonArgs,
  readLastTag,
  readLedger,
  readPreviousTag,
  readProjectVersion,
  statusToJson,
} from "./core.mjs";
import { checkArtifact } from "./checks.mjs";

const USAGE = `用法：node scripts/release/status.mjs [--json|--markdown] [--root <repo>]

  --json       输出机器可读状态
  --markdown   输出适合 GitHub issue 的 markdown
  --root       仓库根目录（默认当前仓库）

状态：pending=待发布，ready=已是最新/无需更新，missing=已声明发布但线上缺件。
本命令只读，不会发布任何东西。`;

async function main() {
  const args = parseCommonArgs(process.argv.slice(2), { allowMarkdown: true });
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.json && args.markdown) throw new Error("--json 与 --markdown 不能同时使用");

  const manifest = await loadManifest(args.root);
  const version = await readProjectVersion(args.root);
  const lastTag = await readLastTag(args.root, manifest.tagPrefix);
  const currentTag = `${manifest.tagPrefix}${version}`;
  const tagged = await hasTag(args.root, currentTag);
  // 当前版本已打标签时，发布范围是“上一个版本标签 → 现在”，不是“当前标签 → 现在”。
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

  if (args.json) {
    process.stdout.write(statusToJson(status));
  } else if (args.markdown) {
    process.stdout.write(formatStatusMarkdown(status));
  } else {
    process.stdout.write(formatStatusText(status));
  }
}

main().catch((error) => {
  console.error(`[release:status] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
