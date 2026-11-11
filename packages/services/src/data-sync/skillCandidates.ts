import { existsSync } from "node:fs";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  MAX_SKILL_SCAN_DEPTH,
  shouldWalkSkillDirectoryEntry,
  walkSkillMarkdownPaths,
} from "../skills/skillDiscoveryWalk.js";

const SKILL_FILE_NAME = "SKILL.md";

/** 用户级技能候选：path 指向技能目录下的 SKILL.md。 */
export interface UserSkillCandidate {
  name: string;
  directoryName: string;
  description: string;
  path: string;
}

export function resolveUserHomeDir(): string {
  const envHome = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

/** 用户级 ZCode 技能目录（NIBI 使用 `~/.nibi/skills`，与设置页技能服务一致）。 */
export function getUserZcodeSkillRoot(): string {
  return join(resolveUserHomeDir(), ".nibi", "skills");
}

/** 兼容目录：用户级 `~/.agents/skills`。 */
function getUserAgentsSkillRoot(): string {
  return join(resolveUserHomeDir(), ".agents", "skills");
}

/**
 * 用户级技能候选：`~/.nibi/skills` 优先，`~/.agents/skills` 中同目录名或同 name 的项剔除，再按 realpath 去重。
 * 扫描规则与设置页技能服务保持一致；数据同步模块自带一份，避免与 skill-sync 服务互相导入形成环。
 */
export async function collectUserSkillCandidates(): Promise<UserSkillCandidate[]> {
  const seenSkillRealpaths = new Set<string>();
  const userZcodeSkillRoot = getUserZcodeSkillRoot();
  const rawZcodeCandidates = await collectUserSkillCandidatesInRoot(userZcodeSkillRoot);
  const zcodeDirectoryNames = await collectCoveredSkillDirectoryNamesInRoot(userZcodeSkillRoot);
  const zcodeSkillNameKeys = new Set(
    rawZcodeCandidates.map((candidate) => normalizeSkillNameKey(candidate.name)),
  );
  const zcodeCandidates = await dedupeCandidatesByCanonicalSkillPath(
    rawZcodeCandidates,
    seenSkillRealpaths,
  );
  const agentsCandidates = await dedupeCandidatesByCanonicalSkillPath(
    (await collectUserSkillCandidatesInRoot(getUserAgentsSkillRoot())).filter(
      (candidate) =>
        !zcodeDirectoryNames.has(candidate.directoryName) &&
        !zcodeSkillNameKeys.has(normalizeSkillNameKey(candidate.name)),
    ),
    seenSkillRealpaths,
  );

  return [...zcodeCandidates, ...agentsCandidates].sort((left, right) =>
    left.directoryName.localeCompare(right.directoryName),
  );
}

async function dedupeCandidatesByCanonicalSkillPath(
  candidates: UserSkillCandidate[],
  seenSkillRealpaths: Set<string>,
): Promise<UserSkillCandidate[]> {
  const result: UserSkillCandidate[] = [];
  for (const candidate of candidates) {
    const canonicalPath = await realpath(candidate.path).catch(() => candidate.path);
    if (seenSkillRealpaths.has(canonicalPath)) {
      continue;
    }
    seenSkillRealpaths.add(canonicalPath);
    result.push(candidate);
  }
  return result;
}

async function collectUserSkillCandidatesInRoot(root: string): Promise<UserSkillCandidate[]> {
  if (!existsSync(root)) {
    return [];
  }
  const candidates: UserSkillCandidate[] = [];
  for await (const skillPath of walkSkillMarkdownPaths(root)) {
    const directoryPath = dirname(skillPath);
    const relativePath = normalizeSkillDirectoryRelativePath(root, directoryPath);
    if (!relativePath) {
      continue;
    }
    const content = await readSkillFileOrNull(skillPath);
    if (content !== null) {
      const metadata = parseSkillMetadata(content, basename(relativePath));
      candidates.push({
        name: metadata.name,
        directoryName: relativePath,
        description: metadata.description,
        path: skillPath,
      });
    }
  }

  // 与设置页一致：复用有界扫描策略，遇到环形目录软链不会卡住。
  return candidates.sort((left, right) => left.directoryName.localeCompare(right.directoryName));
}

async function collectCoveredSkillDirectoryNamesInRoot(root: string): Promise<Set<string>> {
  const directoryNames = new Set<string>();
  if (!existsSync(root)) {
    return directoryNames;
  }
  const stack: Array<{ directoryPath: string; relativePath: string; depth: number }> = [
    { directoryPath: root, relativePath: "", depth: 0 },
  ];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    const skillFilePath = join(current.directoryPath, SKILL_FILE_NAME);
    if (current.relativePath && (await readSkillFileOrNull(skillFilePath))) {
      directoryNames.add(current.relativePath);
    }
    if (current.depth >= MAX_SKILL_SCAN_DEPTH) {
      continue;
    }
    let entries;
    try {
      entries = await readdir(current.directoryPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const entry of entries) {
      if (!shouldWalkSkillDirectoryEntry(entry.name)) {
        continue;
      }
      const entryPath = join(current.directoryPath, entry.name);
      const isDirectory =
        entry.isDirectory() ||
        (entry.isSymbolicLink() && (await stat(entryPath).catch(() => undefined))?.isDirectory());
      if (!isDirectory) {
        continue;
      }
      stack.push({
        directoryPath: entryPath,
        relativePath: joinSkillRelativePath(current.relativePath, entry.name),
        depth: current.depth + 1,
      });
    }
  }

  return directoryNames;
}

function normalizeSkillDirectoryRelativePath(root: string, directoryPath: string): string {
  return relative(root, directoryPath).replaceAll("\\", "/");
}

export function normalizeSkillNameKey(name: string): string {
  return name.trim().toLowerCase();
}

function joinSkillRelativePath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

export async function readSkillFileOrNull(skillPath: string): Promise<string | null> {
  try {
    return await readFile(skillPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function parseSkillMetadata(
  content: string,
  fallbackName: string,
): {
  name: string;
  description: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match) {
    return { name: fallbackName, description: "" };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    return { name: fallbackName, description: "" };
  }
  const metadata = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const name =
    typeof metadata.name === "string" && metadata.name.trim() ? metadata.name.trim() : fallbackName;
  const description = typeof metadata.description === "string" ? metadata.description.trim() : "";
  return { name, description };
}
