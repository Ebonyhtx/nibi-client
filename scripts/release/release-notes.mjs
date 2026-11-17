#!/usr/bin/env node
// pnpm check:release-notes
//
// 发布说明门禁：CHANGELOG.md 的每个版本条目必须是用户口径（新功能 / 问题修复 / 变更），
// 不出现工程实现、内部组件、路径/命令与安全细节；并把同一份文案同步到 GitHub Release 页。
//
//   node scripts/release/release-notes.mjs                  # 校验 CHANGELOG（含当前版本在顶部）
//   node scripts/release/release-notes.mjs --print          # 打印当前版本的 GitHub Release 正文
//   node scripts/release/release-notes.mjs --check-github   # 只读：核对线上 Release 正文与本地一致
//   node scripts/release/release-notes.mjs --publish        # 用本文件覆盖/创建当前版本的 Release
//
// --publish 需要已登录的 gh CLI 与已推送的标签；它只改 Release 说明，不创建标签、不动产物。

import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { REPO_ROOT, readProjectVersion } from "./core.mjs";
import {
  GITHUB_REPO,
  buildGithubReleaseBody,
  normalizeReleaseBody,
  parseChangelog,
  releaseTag,
  releaseTitle,
  validateChangelog,
} from "./release-notes-core.mjs";

const execFile = promisify(execFileCallback);

const USAGE = `用法：node scripts/release/release-notes.mjs [--check|--print|--check-github|--publish] [--version X] [--root <repo>] [--json]

  --check         校验 CHANGELOG.md（默认）
  --print         打印本版 GitHub Release 正文
  --check-github  核对 GitHub Release 正文与 CHANGELOG 同源
  --publish       用 CHANGELOG 的正文创建/更新 GitHub Release
  --version       指定版本（默认 package.json 的版本）
  --json          机器可读输出`;

function parseArgs(argv) {
  const args = { mode: "check", version: null, root: REPO_ROOT, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--check":
        args.mode = "check";
        break;
      case "--print":
        args.mode = "print";
        break;
      case "--check-github":
        args.mode = "check-github";
        break;
      case "--publish":
        args.mode = "publish";
        break;
      case "--version":
        index += 1;
        args.version = argv[index];
        break;
      case "--root":
        index += 1;
        args.root = argv[index];
        break;
      case "--json":
        args.json = true;
        break;
      case "--help":
      case "-h":
        args.mode = "help";
        break;
      default:
        throw new Error(`未知参数：${flag}`);
    }
  }
  return args;
}

async function loadNotes(root) {
  const changelogPath = join(root, "CHANGELOG.md");
  const text = await readFile(changelogPath, "utf8");
  const version = await readProjectVersion(root);
  return { text, version, changelogPath };
}

async function githubRelease(version) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${releaseTag(version)}`;
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "nibi-release-notes-gate",
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, { headers });
    if (response.status === 404) return null;
    if (response.ok) return response.json();
    if (attempt === 3) {
      throw new Error(`读取 GitHub Release 失败：HTTP ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
  return null;
}

async function publish(version, body) {
  const tag = releaseTag(version);
  try {
    await execFile("git", ["rev-parse", "--verify", `refs/tags/${tag}`], { cwd: REPO_ROOT });
  } catch {
    throw new Error(`标签 ${tag} 不存在；先按发版流程打标签并推送`);
  }
  const directory = await mkdtemp(join(tmpdir(), "nibi-release-notes-"));
  const notesFile = join(directory, "notes.md");
  await writeFile(notesFile, body, "utf8");
  try {
    let exists = true;
    try {
      await execFile("gh", ["release", "view", tag, "--repo", GITHUB_REPO], { cwd: REPO_ROOT });
    } catch {
      exists = false;
    }
    const args = exists
      ? ["release", "edit", tag, "--repo", GITHUB_REPO, "--title", releaseTitle(version), "--notes-file", notesFile]
      : [
          "release",
          "create",
          tag,
          "--repo",
          GITHUB_REPO,
          "--title",
          releaseTitle(version),
          "--notes-file",
          notesFile,
          "--verify-tag",
        ];
    const { stdout, stderr } = await execFile("gh", args, { cwd: REPO_ROOT });
    return `${stdout}${stderr}`.trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function report(violations) {
  for (const violation of violations) console.error(`- ${violation}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === "help") {
    console.log(USAGE);
    return;
  }

  const { text, version, changelogPath } = await loadNotes(args.root);
  const targetVersion = args.version ?? version;
  const { entries, violations } = validateChangelog(text, {
    ...(args.version ? { version: args.version } : { currentVersion: version }),
  });

  const entry = entries.find((item) => item.version === targetVersion);
  if (!entry) {
    violations.push(`CHANGELOG.md 里没有 ${targetVersion} 的条目（${changelogPath}）`);
  }

  if (args.mode === "print") {
    if (violations.length > 0) {
      console.error("发布说明不符合口径，不能生成 Release 正文：");
      report(violations);
      process.exitCode = 1;
      return;
    }
    console.log(buildGithubReleaseBody(entry));
    return;
  }

  if (args.mode === "publish") {
    if (violations.length > 0) {
      console.error("发布说明不符合口径，拒绝发布：");
      report(violations);
      process.exitCode = 1;
      return;
    }
    const output = await publish(targetVersion, buildGithubReleaseBody(entry));
    console.log(`已更新 ${releaseTitle(targetVersion)} 的 GitHub Release 说明。`);
    if (output) console.log(output);
    return;
  }

  if (args.mode === "check-github") {
    if (violations.length > 0) {
      console.error("发布说明不符合口径：");
      report(violations);
      process.exitCode = 1;
      return;
    }
    const release = await githubRelease(targetVersion);
    if (!release) {
      violations.push(`GitHub 上还没有 ${releaseTag(targetVersion)} 的 Release 页`);
    } else {
      const expected = normalizeReleaseBody(buildGithubReleaseBody(entry));
      const actual = normalizeReleaseBody(String(release.body ?? ""));
      if (expected !== actual) {
        violations.push(
          `GitHub Release 正文与 CHANGELOG 不一致；运行 pnpm release:notes:publish 覆盖`,
        );
      }
      if (release.name !== releaseTitle(targetVersion)) {
        violations.push(`GitHub Release 标题应为 “${releaseTitle(targetVersion)}”`);
      }
    }
    if (args.json) {
      console.log(JSON.stringify({ version: targetVersion, ok: violations.length === 0, violations }, null, 2));
    } else if (violations.length === 0) {
      console.log(`发布说明通过：${releaseTag(targetVersion)} 的 GitHub Release 与 CHANGELOG 同源。`);
    } else {
      report(violations);
    }
    if (violations.length > 0) process.exitCode = 1;
    return;
  }

  if (args.json) {
    console.log(JSON.stringify({ version: targetVersion, ok: violations.length === 0, violations }, null, 2));
  } else if (violations.length === 0) {
    console.log(`发布说明通过：共 ${entries.length} 个版本，顶部 ${entries[0]?.version}。`);
  } else {
    console.error("发布说明不符合口径：");
    report(violations);
  }
  if (violations.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});