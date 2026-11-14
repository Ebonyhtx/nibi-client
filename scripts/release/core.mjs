#!/usr/bin/env node
// 发布台账的纯逻辑：清单、git 改动面、台账读写、状态判定与输出。
// 网络校验在 checks.mjs；这里不发起任何网络请求，方便单测。

import { execFile as execFileCallback } from "node:child_process";
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const MANIFEST_FILE = "release-manifest.json";
export const LEDGER_FILE = "release/ledger.json";

const CHECK_KINDS = new Set(["npm", "source-server", "desktop", "web-release", "plugin-market"]);

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function validateManifest(manifest) {
  assert(isRecord(manifest), "release-manifest.json 必须是对象");
  assert(manifest.schemaVersion === 1, "release-manifest.json schemaVersion 必须是 1");
  assert(manifest.versionSource === "package.json", "versionSource 必须是 package.json");
  assert(typeof manifest.tagPrefix === "string" && manifest.tagPrefix.length > 0, "tagPrefix 缺失");
  assert(Array.isArray(manifest.artifacts) && manifest.artifacts.length > 0, "artifacts 不能为空");

  const ids = new Set();
  for (const artifact of manifest.artifacts) {
    assert(isRecord(artifact), "artifact 必须是对象");
    assert(typeof artifact.id === "string" && artifact.id.length > 0, "artifact.id 缺失");
    assert(!ids.has(artifact.id), `artifact.id 重复：${artifact.id}`);
    ids.add(artifact.id);
    assert(
      typeof artifact.label === "string" && artifact.label.length > 0,
      `${artifact.id}.label 缺失`,
    );
    assert(Array.isArray(artifact.paths), `${artifact.id}.paths 必须是数组`);
    for (const pattern of artifact.paths) {
      assert(typeof pattern === "string" && pattern.length > 0, `${artifact.id}.paths 含空项`);
      assert(
        !pattern.startsWith("/") && !pattern.includes("\\"),
        `${artifact.id} 的 glob 必须是仓库内 POSIX 路径：${pattern}`,
      );
      assert(!pattern.split("/").includes(".."), `${artifact.id} 的 glob 不能越出仓库：${pattern}`);
    }
    assert(isRecord(artifact.check), `${artifact.id}.check 缺失`);
    assert(
      CHECK_KINDS.has(artifact.check.kind),
      `${artifact.id}.check.kind 不支持：${artifact.check.kind}`,
    );
    switch (artifact.check.kind) {
      case "npm":
        assert(
          Array.isArray(artifact.check.packages) && artifact.check.packages.length > 0,
          `${artifact.id}.check.packages 不能为空`,
        );
        assert(typeof artifact.check.meta === "string", `${artifact.id}.check.meta 缺失`);
        break;
      case "source-server":
        assert(
          typeof artifact.check.descriptorUrl === "string" &&
            artifact.check.descriptorUrl.includes("{version}"),
          `${artifact.id}.check.descriptorUrl 必须含 {version}`,
        );
        assert(
          Array.isArray(artifact.check.targets) && artifact.check.targets.length > 0,
          `${artifact.id}.check.targets 不能为空`,
        );
        break;
      case "desktop":
        assert(
          typeof artifact.check.manifestUrl === "string",
          `${artifact.id}.check.manifestUrl 缺失`,
        );
        assert(
          Array.isArray(artifact.check.platforms) && artifact.check.platforms.length > 0,
          `${artifact.id}.check.platforms 不能为空`,
        );
        break;
      case "web-release":
        assert(typeof artifact.check.pageUrl === "string", `${artifact.id}.check.pageUrl 缺失`);
        assert(
          typeof artifact.check.releaseUrl === "string",
          `${artifact.id}.check.releaseUrl 缺失`,
        );
        assert(typeof artifact.check.surface === "string", `${artifact.id}.check.surface 缺失`);
        break;
      case "plugin-market":
        assert(
          typeof artifact.check.catalogUrl === "string",
          `${artifact.id}.check.catalogUrl 缺失`,
        );
        assert(typeof artifact.check.plugin === "string", `${artifact.id}.check.plugin 缺失`);
        break;
    }
  }
  return manifest;
}

export async function loadManifest(root = REPO_ROOT) {
  const path = join(root, MANIFEST_FILE);
  const raw = await readFile(path, "utf8");
  return validateManifest(JSON.parse(raw));
}

export async function readProjectVersion(root = REPO_ROOT) {
  const raw = await readFile(join(root, "package.json"), "utf8");
  const version = JSON.parse(raw)?.version;
  assert(
    typeof version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/u.test(version),
    `package.json version 不合法：${JSON.stringify(version)}`,
  );
  return version;
}

export async function runGit(root, args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await execFile("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    if (allowFailure) return null;
    throw new Error(
      `git ${args.join(" ")} 失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function tagVersion(tagPrefix, tag) {
  if (typeof tag !== "string" || !tag.startsWith(tagPrefix)) return null;
  const version = tag.slice(tagPrefix.length);
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/u.test(version) ? version : null;
}

/** 当前 HEAD 可达的发布标签（按 semver 排序，不是按引用时间）。 */
async function listTags(root, tagPrefix) {
  const output = await runGit(
    root,
    [
      "for-each-ref",
      "--merged=HEAD",
      "--sort=-version:refname",
      "--format=%(refname:short)",
      `refs/tags/${tagPrefix}*`,
    ],
    { allowFailure: true },
  );
  return (output ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => tagVersion(tagPrefix, line) && tagVersion(tagPrefix, line) !== null);
}

export async function readLastTag(root = REPO_ROOT, tagPrefix = "v") {
  return (await listTags(root, tagPrefix))[0] ?? null;
}

/**
 * 当前版本标签已存在时，`git diff <当前标签>` 会把“这次发布包含什么”抹掉；
 * 必须退到当前版本之前的那个标签，才能判断这次发布是否动过某个产物。
 */
export async function readPreviousTag(root = REPO_ROOT, tagPrefix = "v", version) {
  const tags = await listTags(root, tagPrefix);
  return tags.find((tag) => compareVersions(tagVersion(tagPrefix, tag), version) < 0) ?? null;
}

export async function hasTag(root, tag) {
  const output = await runGit(root, ["tag", "--list", tag], { allowFailure: true });
  return (output ?? "").trim() === tag;
}

/**
 * 自 baseline 以来所有改动（含工作树、暂存区、未跟踪文件）。baseline 为空时按
 * “全部文件都是新的”处理，便于首次发布。
 */
export async function collectChangedFiles(root = REPO_ROOT, baseline = null) {
  const files = new Set();
  const trackedOutput = baseline
    ? await runGit(root, ["diff", "--name-only", "--diff-filter=ACDMRTUXB", baseline, "--"])
    : await runGit(root, ["ls-files"]);
  for (const line of (trackedOutput ?? "").split("\n")) {
    const file = line.trim();
    if (file) files.add(file);
  }
  const untrackedOutput = await runGit(root, ["ls-files", "--others", "--exclude-standard"], {
    allowFailure: true,
  });
  for (const line of (untrackedOutput ?? "").split("\n")) {
    const file = line.trim();
    if (file) files.add(file);
  }
  return [...files].sort();
}

export function artifactChangedFiles(artifact, files) {
  if (artifact.paths.length === 0) return [];
  return files.filter((file) =>
    artifact.paths.some((pattern) => {
      try {
        return posix.matchesGlob(file, pattern);
      } catch {
        return false;
      }
    }),
  );
}

export function emptyLedger() {
  return { schemaVersion: 1, updatedAt: new Date().toISOString(), releases: {} };
}

export async function readLedger(root = REPO_ROOT) {
  const path = join(root, LEDGER_FILE);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return emptyLedger();
    throw error;
  }
  const ledger = JSON.parse(raw);
  assert(
    isRecord(ledger) && ledger.schemaVersion === 1,
    "release/ledger.json schemaVersion 必须是 1",
  );
  assert(isRecord(ledger.releases), "release/ledger.json releases 必须是对象");
  return ledger;
}

export async function writeLedger(root, ledger) {
  const path = join(root, LEDGER_FILE);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function ensureRelease(ledger, version) {
  if (!isRecord(ledger.releases[version])) {
    ledger.releases[version] = {
      createdAt: new Date().toISOString(),
      artifacts: {},
    };
  }
  if (!isRecord(ledger.releases[version].artifacts)) {
    ledger.releases[version].artifacts = {};
  }
  return ledger.releases[version];
}

export function artifactRecord(ledger, version, artifactId) {
  const release = ledger?.releases?.[version];
  const record = release?.artifacts?.[artifactId];
  return isRecord(record) ? record : null;
}

/**
 * 记录一个阶段。built 可以离线写；published/verified 由调用方先做远程校验，
 * 只有确认 current 才允许写。
 */
export function recordStage(
  ledger,
  {
    version,
    artifactId,
    stage,
    note,
    revision,
    pluginVersion,
    checks,
    at = new Date().toISOString(),
  },
) {
  const release = ensureRelease(ledger, version);
  const record = isRecord(release.artifacts[artifactId]) ? release.artifacts[artifactId] : {};
  const entry = {
    at,
    version,
    ...(Number.isSafeInteger(revision) ? { revision } : {}),
    ...(typeof pluginVersion === "string" ? { pluginVersion } : {}),
    ...(typeof note === "string" && note.length > 0 ? { note } : {}),
    ...(Array.isArray(checks) && checks.length > 0 ? { checks } : {}),
  };
  record[stage] = entry;
  release.artifacts[artifactId] = record;
  ledger.updatedAt = at;
  return entry;
}

export function compareVersions(left, right) {
  const parse = (value) =>
    String(value)
      .split(/[.+-]/u)
      .slice(0, 3)
      .map((part) => Number(part) || 0);
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  }
  return 0;
}

/**
 * 插件市场不跟产品版本走；台账里最近一次 verified/published 的 revision
 * 就是“上次登记的市场状态”。没有基线时只做目录健康检查。
 */
export function latestMarketplaceBaseline(ledger, artifactId = "plugin-market") {
  const versions = Object.keys(ledger?.releases ?? {})
    .sort(compareVersions)
    .reverse();
  for (const releaseVersion of versions) {
    const record = artifactRecord(ledger, releaseVersion, artifactId);
    if (!record) continue;
    for (const stage of ["verified", "published", "built"]) {
      const entry = record[stage];
      if (isRecord(entry) && Number.isSafeInteger(entry.revision) && entry.revision >= 1) {
        return {
          revision: entry.revision,
          version: typeof entry.pluginVersion === "string" ? entry.pluginVersion : null,
          appVersion: releaseVersion,
          stage,
        };
      }
    }
  }
  return null;
}

function statusDetail({ artifact, check, required, tagged, record }) {
  if (!check) return "未执行校验";
  if (!check.valid) return `校验失败：${check.detail}`;
  if (artifact.check.kind === "plugin-market") {
    if (!check.baseline) return `${check.detail}（未登记基线）`;
    if (check.revision < check.baseline.revision) {
      return `${check.detail}；低于台账 revision ${check.baseline.revision}`;
    }
    if (check.revision > check.baseline.revision) {
      return `${check.detail}；先登记市场 revision ${check.revision}`;
    }
    if (check.pluginVersion !== check.baseline.version) {
      return `${check.detail}；版本与台账 ${check.baseline.version ?? "未知"} 不同`;
    }
    return check.detail;
  }
  if (check.current) return check.detail;
  if (record?.published || record?.verified) return `${check.detail}；台账已记录发布，但线上不可见`;
  if (tagged && required) return `${check.detail}；${artifact.id} 在当前版本标签后仍未发布`;
  if (required) return `${check.detail}；当前版本未发布`;
  return `${check.detail}；自上一标签无改动，无需更新`;
}

/**
 * 状态只有三种（用户口径）：
 *   pending —— 有改动/已构建，但当前版本还没发布
 *   ready   —— 当前版本已完整可见，或这个产物无需更新
 *   missing —— 已声明发布（标签/台账）或只发布了一部分，但线上缺件
 */
export function evaluateArtifact({ artifact, check, record, required, tagged }) {
  if (!check) {
    return { status: "missing", detail: "未执行校验" };
  }
  if (!check.valid) {
    return { status: "missing", detail: `校验失败：${check.detail}` };
  }
  if (artifact.check.kind === "plugin-market") {
    if (!check.baseline) return { status: "ready", detail: check.detail };
    if (check.revision < check.baseline.revision) {
      return {
        status: "missing",
        detail: `市场 revision 回退：${check.revision} < ${check.baseline.revision}`,
      };
    }
    if (check.revision > check.baseline.revision) {
      return { status: "pending", detail: `市场 revision ${check.revision} 尚未登记到台账` };
    }
    if (check.pluginVersion !== check.baseline.version) {
      return {
        status: "pending",
        detail: `市场版本 ${check.pluginVersion} 与台账 ${check.baseline.version ?? "未知"} 不同`,
      };
    }
    return { status: "ready", detail: check.detail };
  }
  if (check.current) return { status: "ready", detail: check.detail };
  if (check.partial || record?.published || record?.verified || (tagged && required)) {
    return { status: "missing", detail: check.detail };
  }
  if (required) return { status: "pending", detail: check.detail };
  return { status: "ready", detail: check.detail };
}

export function buildReleaseStatus({
  manifest,
  version,
  lastTag,
  releaseBaselineTag = lastTag,
  tagged,
  changedFiles,
  changedAfterTag = [],
  ledger,
  checks,
}) {
  const lastVersion = lastTag ? tagVersion(manifest.tagPrefix, lastTag) : null;
  const artifacts = manifest.artifacts.map((artifact) => {
    const files = artifactChangedFiles(artifact, changedFiles);
    const record = artifactRecord(ledger, version, artifact.id);
    const check = checks[artifact.id];
    const required =
      artifact.paths.length > 0 &&
      (files.length > 0 ||
        Boolean(record?.built) ||
        Boolean(record?.published) ||
        Boolean(record?.verified));
    const evaluated = evaluateArtifact({ artifact, check, record, required, tagged });
    const blocksVerify =
      (required && evaluated.status !== "ready") ||
      (artifact.verifyAlways === true && check?.valid === false);
    return {
      id: artifact.id,
      label: artifact.label,
      required,
      changedFiles: files.length,
      status: evaluated.status,
      detail: statusDetail({ artifact, check, required, tagged, record }),
      stage: {
        built: Boolean(record?.built),
        published: Boolean(record?.published),
        verified: Boolean(record?.verified),
      },
      remote: {
        kind: check?.kind ?? artifact.check.kind,
        valid: check?.valid ?? false,
        current: check?.current ?? false,
        present: check?.present ?? 0,
        total: check?.total ?? 0,
        revision: check?.revision,
        pluginVersion: check?.pluginVersion,
        baselineRevision: check?.baseline?.revision ?? null,
      },
      evidence: check?.evidence ?? null,
      blocksVerify,
    };
  });

  const summary = {
    pending: artifacts.filter((artifact) => artifact.status === "pending").length,
    ready: artifacts.filter((artifact) => artifact.status === "ready").length,
    missing: artifacts.filter((artifact) => artifact.status === "missing").length,
    required: artifacts.filter((artifact) => artifact.required).length,
    blocking: artifacts.filter((artifact) => artifact.blocksVerify).length,
  };
  const warnings = [];
  if (tagged && changedAfterTag.length > 0) {
    warnings.push(
      `${manifest.tagPrefix}${version} 标签已存在，但之后又有 ${changedAfterTag.length} 个文件改动；请先 bump 版本再发下一版。`,
    );
  }
  if (
    !tagged &&
    summary.required > 0 &&
    artifacts
      .filter((artifact) => artifact.required)
      .every((artifact) => artifact.status === "ready")
  ) {
    warnings.push(
      `所有需要发布的产物已就绪；打 ${manifest.tagPrefix}${version} 标签后按 release-process.md 发布。`,
    );
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    version,
    lastTag,
    lastVersion,
    releaseBaselineTag,
    tagged,
    changedFiles: changedFiles.length,
    changedAfterTag: changedAfterTag.length,
    artifacts,
    summary,
    warnings,
    ok: summary.blocking === 0,
  };
}

function truncate(value, length = 120) {
  const text = String(value ?? "").replace(/\s+/gu, " ");
  return text.length <= length ? text : `${text.slice(0, length - 1)}…`;
}

function stageLabel(stage) {
  if (stage.verified) return "verified";
  if (stage.published) return "published";
  if (stage.built) return "built";
  return "-";
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

export function formatStatusText(status) {
  const lines = [];
  lines.push(`NIBI 发布状态`);
  lines.push(`当前版本: ${status.version}`);
  lines.push(`上一发布标签: ${status.lastTag ?? "无"}`);
  if (status.tagged) {
    lines.push(`发布范围基线: ${status.releaseBaselineTag ?? "无"}`);
    lines.push(
      `发布范围改动: ${status.changedFiles} 个文件；标签后改动: ${status.changedAfterTag} 个文件`,
    );
  } else {
    lines.push(`自上一标签改动: ${status.changedFiles} 个文件`);
  }
  lines.push("");
  lines.push(`${pad("产物", 28)} ${pad("改动", 6)} ${pad("状态", 9)} ${pad("阶段", 10)} 说明`);
  for (const artifact of status.artifacts) {
    lines.push(
      `${pad(artifact.label, 28)} ${pad(artifact.changedFiles, 6)} ${pad(artifact.status, 9)} ${pad(stageLabel(artifact.stage), 10)} ${truncate(artifact.detail)}`,
    );
  }
  lines.push("");
  lines.push(
    `汇总: pending ${status.summary.pending} / ready ${status.summary.ready} / missing ${status.summary.missing}`,
  );
  if (status.warnings.length > 0) {
    lines.push("");
    for (const warning of status.warnings) lines.push(`提示: ${warning}`);
  }
  lines.push("");
  lines.push("说明: pending=待发布，ready=已是最新/无需更新，missing=已声明发布但线上缺件。");
  lines.push("本命令只读，不会发布任何东西。");
  return `${lines.join("\n")}\n`;
}

export function formatStatusMarkdown(status) {
  const lines = [];
  lines.push("## NIBI 发布状态");
  lines.push("");
  lines.push(`- 当前版本：\`${status.version}\``);
  lines.push(`- 上一发布标签：${status.lastTag ? `\`${status.lastTag}\`` : "无"}`);
  if (status.tagged) {
    lines.push(
      `- 发布范围基线：${status.releaseBaselineTag ? `\`${status.releaseBaselineTag}\`` : "无"}（**${status.changedFiles}** 个文件；标签后 **${status.changedAfterTag}** 个）`,
    );
  } else {
    lines.push(`- 自上一标签改动：**${status.changedFiles}** 个文件`);
  }
  lines.push("");
  lines.push("| 产物 | 改动文件 | 状态 | 台账 | 说明 |");
  lines.push("| --- | ---: | --- | --- | --- |");
  for (const artifact of status.artifacts) {
    lines.push(
      `| ${artifact.label} | ${artifact.changedFiles} | \`${artifact.status}\` | ${stageLabel(artifact.stage)} | ${truncate(artifact.detail, 160).replaceAll("|", "\\|")} |`,
    );
  }
  lines.push("");
  lines.push(
    `汇总：pending ${status.summary.pending} / ready ${status.summary.ready} / missing ${status.summary.missing}`,
  );
  if (status.warnings.length > 0) {
    lines.push("");
    for (const warning of status.warnings) lines.push(`> ${warning}`);
  }
  lines.push("");
  lines.push("本 issue 每周自动更新。发布步骤见 `docs/release-process.md`；本流程不会自动发布。");
  return `${lines.join("\n")}\n`;
}

export function statusToJson(status) {
  return `${JSON.stringify(status, null, 2)}\n`;
}

export function parseCommonArgs(
  argv,
  { allowRecord = false, allowDeep = false, allowMarkdown = false } = {},
) {
  const args = { json: false, markdown: false, record: false, deep: false, root: REPO_ROOT };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case "--json":
        args.json = true;
        break;
      case "--markdown":
        if (!allowMarkdown) throw new Error("--markdown 不支持此命令");
        args.markdown = true;
        break;
      case "--record":
        if (!allowRecord) throw new Error("--record 不支持此命令");
        args.record = true;
        break;
      case "--deep":
        if (!allowDeep) throw new Error("--deep 不支持此命令");
        args.deep = true;
        break;
      case "--root": {
        const value = argv[index + 1];
        if (!value) throw new Error("--root 缺少路径");
        args.root = resolve(value);
        index += 1;
        break;
      }
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`未知参数：${flag}`);
    }
  }
  return args;
}
