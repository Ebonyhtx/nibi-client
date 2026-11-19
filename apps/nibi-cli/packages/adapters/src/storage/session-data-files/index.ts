// 会话文件面：`<cli>/artifacts|exec|agents|sessions/<sid>` 与
// `<cli>/{debug,rollout}/model-io-<sid>.jsonl`。永久删除用它列文件、删文件；
// 口径与 kernel/crates/node-store/src/session_data.rs 一致。
//
// 只统计真实文件：符号链接按 0 字节且不跟随；缺失按 0；数据库行不计入。
// 类别目录被换成链接时拒绝删除（session-data.symlink-root），不沿链接动用户文件。
import { lstat, readdir, rm } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";

export const SESSION_DATA_DIRECTORY_ROOTS = ["artifacts", "exec", "agents", "sessions"] as const;
export const SESSION_DATA_MODEL_IO_DIRECTORIES = ["debug", "rollout"] as const;

export type SessionDataFileErrorCode =
  | "session-data.invalid-session-id"
  | "session-data.symlink-root"
  | string;

export class SessionDataFileError extends Error {
  constructor(
    readonly code: SessionDataFileErrorCode,
    message = code,
  ) {
    super(message);
    this.name = "SessionDataFileError";
  }
}

/** 一个会话在磁盘上的一个文件（路径相对存储根；`artifact` = 在附件目录里）。 */
export interface SessionDataFile {
  relativePath: string;
  name: string;
  artifact: boolean;
  bytes: number;
}

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/u;

/** 会话 ID 直接拼进路径，必须是单个安全文件名段（上游 SAFE_SESSION_ID）。 */
export function assertSafeSessionID(sessionID: string): string {
  if (!SAFE_SESSION_ID.test(sessionID)) {
    throw new SessionDataFileError("session-data.invalid-session-id");
  }
  return sessionID;
}

interface SessionLocations {
  directories: string[];
  files: string[];
}

/** 会话的类别目录（第一个是附件目录）与模型轨迹文件。 */
export function sessionLocations(cliRoot: string, sessionID: string): SessionLocations {
  const id = assertSafeSessionID(sessionID);
  return {
    directories: SESSION_DATA_DIRECTORY_ROOTS.map((name) => join(cliRoot, name, id)),
    files: SESSION_DATA_MODEL_IO_DIRECTORIES.map((name) =>
      join(cliRoot, name, `model-io-${id}.jsonl`),
    ),
  };
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function fileError(error: unknown): SessionDataFileError {
  if (error instanceof SessionDataFileError) return error;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "unknown")
      : "unknown";
  return new SessionDataFileError(code);
}

/** 类别目录若被换成链接，不能沿祖先链接清理用户文件（同上游）。 */
async function assertCategoryNotSymlink(location: string): Promise<void> {
  try {
    const info = await lstat(dirname(location));
    if (info.isSymbolicLink()) throw new SessionDataFileError("session-data.symlink-root");
  } catch (error) {
    if (isMissing(error)) return;
    throw fileError(error);
  }
}

interface FoundFile {
  path: string;
  bytes: number;
}

/** 递归列真实文件；符号链接作为 0 字节文件列出，不跟随。 */
async function collectTreeFiles(path: string, found: FoundFile[]): Promise<void> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return;
    throw fileError(error);
  }
  if (info.isSymbolicLink()) {
    found.push({ path, bytes: 0 });
    return;
  }
  if (!info.isDirectory()) {
    found.push({ path, bytes: info.size });
    return;
  }
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) await collectTreeFiles(join(path, entry.name), found);
}

/** 这个会话的文件，按相对存储根的路径排序。 */
export async function listSessionFiles(
  cliRoot: string,
  sessionID: string,
): Promise<SessionDataFile[]> {
  const locations = sessionLocations(cliRoot, sessionID);
  const found: SessionDataFile[] = [];
  const add = (files: FoundFile[], artifact: boolean) => {
    for (const file of files) {
      found.push({
        relativePath: relative(cliRoot, file.path),
        name: basename(file.path),
        artifact,
        bytes: file.bytes,
      });
    }
  };
  for (const [index, directory] of locations.directories.entries()) {
    await assertCategoryNotSymlink(directory);
    const files: FoundFile[] = [];
    await collectTreeFiles(directory, files);
    add(files, index === 0);
  }
  for (const file of locations.files) {
    await assertCategoryNotSymlink(file);
    const files: FoundFile[] = [];
    await collectTreeFiles(file, files);
    add(files, false);
  }
  found.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return found;
}

/**
 * 删这个会话的文件。没有要留的时每个位置整个删；有时附件目录里只删文件名不含
 * 任何一个 `retainedArtifactIDs` 的文件（留下 URI 定位所需的附件），其余位置整个删。
 * 已不存在按成功处理（幂等）。
 */
export async function removeSession(
  cliRoot: string,
  sessionID: string,
  retainedArtifactIDs: readonly string[] = [],
): Promise<void> {
  const locations = sessionLocations(cliRoot, sessionID);
  const [artifacts, ...rest] = locations.directories;
  if (!artifacts) throw new SessionDataFileError("session-data.invalid-session-id");
  for (const directory of locations.directories) await assertCategoryNotSymlink(directory);
  for (const file of locations.files) await assertCategoryNotSymlink(file);
  try {
    const keep = retainedArtifactIDs.filter((artifactID) => artifactID.length > 0);
    if (keep.length === 0) {
      await rm(artifacts, { recursive: true, force: true });
    } else {
      const files: FoundFile[] = [];
      await collectTreeFiles(artifacts, files);
      for (const file of files) {
        const name = basename(file.path);
        if (keep.some((artifactID) => name.includes(artifactID))) continue;
        await rm(file.path, { force: true });
      }
    }
    for (const location of [...rest, ...locations.files]) {
      await rm(location, { recursive: true, force: true });
    }
  } catch (error) {
    throw fileError(error);
  }
}
