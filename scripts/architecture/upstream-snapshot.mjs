import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gitFileNames } from "./git-file-names.mjs";

export function isSnapshotPath(value) {
  return (
    typeof value === "string" &&
    !value.includes("\\") &&
    value.split("/").every((part) => part && part !== "." && part !== "..") &&
    !value.includes(":")
  );
}

/**
 * 本地源码目录已改成 NIBI 名，但快照键必须保留上游路径——重写键等于伪造上游历史。
 * 比较前把本地路径映射回上游路径；回传的 accepted/historical 仍是本地路径，
 * 下游按当前工作区文件判断。
 */
export const LOCAL_TO_UPSTREAM_PREFIXES = [
  ["apps/nibi-cli/", "apps/zcode-cli/"],
  ["packages/nibi-server-cli/", "packages/zcode-server-cli/"],
];

export function toUpstreamPath(localPath) {
  for (const [local, upstream] of LOCAL_TO_UPSTREAM_PREFIXES) {
    if (localPath.startsWith(local)) return `${upstream}${localPath.slice(local.length)}`;
  }
  return localPath;
}

export function toLocalPath(upstreamPath) {
  for (const [local, upstream] of LOCAL_TO_UPSTREAM_PREFIXES) {
    if (upstreamPath.startsWith(upstream)) return `${local}${upstreamPath.slice(upstream.length)}`;
  }
  return upstreamPath;
}

/**
 * 映射前缀必须真的存在于快照里。自映射（nibi→nibi）曾经让判据静默空转：
 * 快照键是上游历史路径，映射错了不会报错，只会把所有文件判成"非上游"。
 * 这里在读取时直接拒绝，让配置/快照漂移在第一次运行时暴露。
 */
function assertMappedPrefixesPresent(snapshot) {
  for (const [, upstream] of LOCAL_TO_UPSTREAM_PREFIXES) {
    const present = [
      ...Object.keys(snapshot.files),
      ...Object.keys(snapshot.historicalFiles ?? {}),
    ].some((file) => file.startsWith(upstream));
    if (!present) {
      throw new Error(`acceptedUpstreamSnapshot 缺少映射前缀 ${upstream}：映射与快照不一致`);
    }
  }
}

function isFileMap(files) {
  return (
    files &&
    typeof files === "object" &&
    !Array.isArray(files) &&
    Object.entries(files).every(
      ([file, blob]) =>
        isSnapshotPath(file) &&
        typeof blob === "string" &&
        /^(100644|100755|120000) [a-f0-9]{40}$/.test(blob),
    )
  );
}

/** 独立公开历史没有源仓库对象；固定内容与模式仍须同时匹配暂存区和工作区。 */
export async function readUpstreamSnapshot(cwd, snapshotPath) {
  if (!isSnapshotPath(snapshotPath)) throw new Error("acceptedUpstreamSnapshot 路径无效");
  const snapshot = JSON.parse(await readFile(resolve(cwd, snapshotPath), "utf8"));
  if (
    snapshot.version !== 1 ||
    !isFileMap(snapshot.files) ||
    !isFileMap(snapshot.historicalFiles ?? {}) ||
    !Array.isArray(snapshot.introduced) ||
    !snapshot.introduced.every(isSnapshotPath)
  ) {
    throw new Error("acceptedUpstreamSnapshot 清单无效");
  }
  assertMappedPrefixesPresent(snapshot);
  const [index, dirty] = await Promise.all([
    gitFileNames(cwd, ["ls-files", "--stage", "-z"]),
    gitFileNames(cwd, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-only",
      "-z",
      "--",
    ]),
  ]);
  const different = new Set(dirty);
  const accepted = new Set();
  const historical = new Set();
  for (const entry of index) {
    const separator = entry.indexOf("\t");
    const file = entry.slice(separator + 1);
    const [mode, blob, stage] = entry.slice(0, separator).split(" ");
    const upstreamFile = toUpstreamPath(file);
    if (stage === "0" && !different.has(file) && snapshot.files[upstreamFile] === `${mode} ${blob}`)
      accepted.add(file);
    if (
      stage === "0" &&
      !different.has(file) &&
      snapshot.historicalFiles?.[upstreamFile] === `${mode} ${blob}`
    )
      historical.add(file);
  }
  return {
    accepted,
    historical,
    introduced: snapshot.introduced.map(toLocalPath),
  };
}
