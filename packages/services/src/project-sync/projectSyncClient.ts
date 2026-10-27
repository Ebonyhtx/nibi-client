// 云端项目协作（P1）客户端核心：工作副本清单、对象去重上传、快进提交、拉取与冲突报告。
//
// 服务端契约见云端项目协作协议。
// 这里只做「本地文件 ↔ 项目版本」的机械同步，不碰 UI、不碰 token：
// 传输由调用方注入（宿主里是带登录令牌与代理感知的 HTTP 客户端），便于单测与复用。
//
// 不变式：
//   - 工作副本只认一个 base（`.nibi-project.json` 的 baseVersion/baseFiles）；
//   - 上传永远带 baseVersion，服务端 409 时**不写清单、不改本地文件**；
//   - 拉取前把将被覆盖/删除的本地文件快照到 `.nibi-project-backups/<时间>/`。
import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { ServiceChannels } from "@nibi/shared";
import { createServiceDescriptor } from "../descriptors.js";

export const PROJECT_MANIFEST_FILE = ".nibi-project.json";
export const PROJECT_BACKUP_DIR = ".nibi-project-backups";
const MAX_FILE_BYTES = 50 * 1024 * 1024;

const EXCLUDED_DIRS = new Set([
  ".git",
  ".nibi",
  ".nibi-share",
  ".nibi-project-backups",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  "提交",
  ".idea",
  ".vscode",
]);
const EXCLUDED_NAMES = new Set([
  PROJECT_MANIFEST_FILE,
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
]);
const EXCLUDED_PREFIXES = [".tmp-", "~$"];

export interface ProjectManifest {
  projectId: string;
  serverUrl: string;
  baseVersion: number;
  baseFiles: Record<string, string>;
  updatedAt?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  role: "owner" | "editor" | "viewer";
  headVersion: number;
  members?: number;
  headKind?: string | null;
  headConflicts?: MergeConflictDetail[];
}

export interface VersionFileSet {
  revision: number;
  files: Record<string, string>;
  deleted: string[];
  message?: string;
  parents?: number[];
  kind?: string;
  conflicts?: MergeConflictDetail[];
}

export interface MergeConflictDetail {
  path: string;
  reason: string;
  baseSha: string | null;
  headSha: string | null;
  localSha: string | null;
}

export type UploadResult =
  | { kind: "committed"; revision: number; uploadedObjects: number; reusedObjects: number }
  | {
      kind: "merged";
      revision: number;
      baseVersion: number;
      parents: number[];
      mergedPaths: string[];
      takenRemotePaths: string[];
      takenLocalPaths: string[];
      pulled: boolean;
      pullError?: string;
    }
  | { kind: "up_to_date"; headVersion: number; pulled: boolean; pullError?: string }
  | {
      kind: "conflict";
      headVersion: number;
      draftRevision?: number | null;
      conflictingPaths: string[];
      conflicts?: MergeConflictDetail[];
      message: string;
    };

export type ConflictChoice = "ours" | "theirs";

export interface ResolveConflictResult {
  kind: "merge" | "draft";
  revision: number;
  resolved: number;
  conflictsRemaining: MergeConflictDetail[];
  pulled: boolean;
  pullError?: string;
}

/** 宿主 RPC 暴露面：面板/UI 只依赖这个描述符，不直接持有客户端实例。 */
export interface IProjectSyncService {
  createProject(name: string): Promise<{ project: ProjectSummary; inviteCode: string }>;
  joinProject(inviteCode: string): Promise<ProjectSummary>;
  listProjects(): Promise<ProjectSummary[]>;
  projectStatus(
    projectId: string,
  ): Promise<{ project: ProjectSummary; headVersion: number; members: unknown[] }>;
  getVersion(projectId: string, revision: number): Promise<VersionFileSet>;
  upload(workspacePath: string, projectId: string, message?: string): Promise<UploadResult>;
  pull(workspacePath: string, projectId: string): Promise<PullResult>;
  resolveConflicts(
    workspacePath: string,
    projectId: string,
    revision: number,
    choices: Record<string, ConflictChoice>,
  ): Promise<ResolveConflictResult>;
}

export const IProjectSyncService = createServiceDescriptor<IProjectSyncService>(
  ServiceChannels.ProjectSync,
);

export type PullResult = {
  revision: number;
  written: number;
  removed: number;
  backupDir: string | null;
};

export interface ProjectSyncTransport {
  /** JSON 请求；返回解析后的 body 与 HTTP 状态。 */
  request(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }>;
  /** 原始字节上传（PUT object）。 */
  uploadObject(
    path: string,
    bytes: Uint8Array,
    sha256: string,
  ): Promise<{ status: number; body: unknown }>;
  /** 原始字节下载（GET object）。 */
  downloadObject(path: string): Promise<{ status: number; bytes: Uint8Array }>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function isExcluded(relativePath: string): boolean {
  const parts = relativePath.split("/");
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) return true;
  const name = parts[parts.length - 1] ?? "";
  if (EXCLUDED_NAMES.has(name)) return true;
  return EXCLUDED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** 扫描工作区：只读、跳过缓存/临时/提交目录；符号链接不跟（防止把工作区外内容同步上去）。 */
export async function collectWorkspaceFiles(
  workspacePath: string,
): Promise<{ files: Record<string, string>; bytes: Map<string, Uint8Array> }> {
  const root = resolve(workspacePath);
  const files: Record<string, string> = {};
  const bytes = new Map<string, Uint8Array>();
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const relativePath = toPosix(relative(root, absolute));
      if (isExcluded(relativePath)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(absolute);
      if (info.size > MAX_FILE_BYTES) {
        throw new Error(`文件超过单文件上限（${MAX_FILE_BYTES} 字节）：${relativePath}`);
      }
      const content = new Uint8Array(await readFile(absolute));
      files[relativePath] = sha256(content);
      bytes.set(relativePath, content);
    }
  }
  await walk(root);
  return { files, bytes };
}

export async function readProjectManifest(
  workspacePath: string,
): Promise<ProjectManifest | null> {
  try {
    const raw = await readFile(join(workspacePath, PROJECT_MANIFEST_FILE), "utf8");
    const parsed = JSON.parse(raw) as ProjectManifest;
    if (
      typeof parsed?.projectId !== "string" ||
      typeof parsed?.baseVersion !== "number" ||
      typeof parsed?.baseFiles !== "object" ||
      parsed.baseFiles === null
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function writeProjectManifest(
  workspacePath: string,
  manifest: ProjectManifest,
): Promise<void> {
  const path = join(workspacePath, PROJECT_MANIFEST_FILE);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function changedPaths(
  base: Record<string, string>,
  current: Record<string, string>,
  deleted: readonly string[],
): string[] {
  const changed = new Set<string>();
  for (const [path, sha] of Object.entries(current)) {
    if (base[path] !== sha) changed.add(path);
  }
  for (const path of Object.keys(base)) {
    if (!(path in current)) changed.add(path);
  }
  for (const path of deleted) changed.add(path);
  return [...changed];
}

export class ProjectSyncClient implements IProjectSyncService {
  constructor(
    private readonly transport: ProjectSyncTransport,
    private readonly serverUrl = "",
  ) {}

  async createProject(name: string): Promise<{ project: ProjectSummary; inviteCode: string }> {
    const response = await this.transport.request("POST", "/api/v1/projects", { name });
    if (response.status !== 200) throw new Error(apiError(response, "创建项目失败"));
    const data = response.body as {
      data?: { project?: ProjectSummary; inviteCode?: string };
    };
    if (!data.data?.project || typeof data.data.inviteCode !== "string") {
      throw new Error("创建项目响应无效");
    }
    return { project: data.data.project, inviteCode: data.data.inviteCode };
  }

  async joinProject(inviteCode: string): Promise<ProjectSummary> {
    const response = await this.transport.request("POST", "/api/v1/projects/join", {
      inviteCode,
    });
    if (response.status !== 200) throw new Error(apiError(response, "加入项目失败"));
    const project = (response.body as { data?: { project?: ProjectSummary } }).data?.project;
    if (!project) throw new Error("加入项目响应无效");
    return project;
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const response = await this.transport.request("GET", "/api/v1/projects");
    if (response.status !== 200) throw new Error(apiError(response, "读取项目列表失败"));
    return (response.body as { data?: { projects?: ProjectSummary[] } }).data?.projects ?? [];
  }

  async projectStatus(
    projectId: string,
  ): Promise<{
    project: ProjectSummary;
    headVersion: number;
    headKind: string | null;
    headConflicts: MergeConflictDetail[];
    members: unknown[];
  }> {
    const response = await this.transport.request("GET", `/api/v1/projects/${projectId}`);
    if (response.status !== 200) throw new Error(apiError(response, "读取项目失败"));
    const data = (
      response.body as {
        data?: { project?: ProjectSummary; members?: unknown[] };
      }
    ).data;
    if (!data?.project) throw new Error("项目响应无效");
    return {
      project: data.project,
      headVersion: Number(data.project.headVersion),
      headKind: data.project.headKind ?? null,
      headConflicts: Array.isArray(data.project.headConflicts)
        ? data.project.headConflicts
        : [],
      members: data.members ?? [],
    };
  }

  async getVersion(projectId: string, revision: number): Promise<VersionFileSet> {
    const response = await this.transport.request(
      "GET",
      `/api/v1/projects/${projectId}/versions/${revision}`,
    );
    if (response.status !== 200) throw new Error(apiError(response, "读取版本失败"));
    const data = (response.body as { data?: VersionFileSet }).data;
    if (!data) throw new Error("版本响应无效");
    return data;
  }

  /**
   * 上传一轮：只传内容变化的 object；提交带 baseVersion。
   * 409 = 云端已更新；返回冲突信息且**不写本地清单**。
   */
  async upload(
    workspacePath: string,
    projectId: string,
    message = "",
  ): Promise<UploadResult> {
    const manifest = await readProjectManifest(workspacePath);
    if (manifest && manifest.projectId !== projectId) {
      throw new Error(`本地工作副本属于另一个项目：${manifest.projectId}`);
    }
    const baseVersion = manifest?.baseVersion ?? 0;
    const baseFiles = manifest?.baseFiles ?? {};
    const { files, bytes } = await collectWorkspaceFiles(workspacePath);
    const deleted = Object.keys(baseFiles).filter((path) => !(path in files));

    let uploaded = 0;
    let reused = 0;
    for (const [path, sha] of Object.entries(files)) {
      if (baseFiles[path] === sha) {
        reused += 1;
        continue;
      }
      const content = bytes.get(path);
      if (!content) continue;
      const response = await this.transport.uploadObject(
        `/api/v1/projects/${projectId}/objects/${sha}`,
        content,
        sha,
      );
      if (response.status !== 200) {
        throw new Error(apiError(response, `上传对象失败：${path}`));
      }
      uploaded += 1;
    }

    const response = await this.transport.request(
      "POST",
      `/api/v1/projects/${projectId}/versions`,
      { baseVersion, files, deleted, message },
    );
    if (response.status === 409) {
      const body = response.body as {
        msg?: string;
        data?: {
          headVersion?: number;
          draftRevision?: number | null;
          conflictingPaths?: unknown;
          conflicts?: unknown;
        };
      };
      const data = body.data;
      const conflicts = Array.isArray(data?.conflicts)
        ? (data.conflicts as MergeConflictDetail[]).filter(
            (item) => item && typeof item.path === "string" && typeof item.reason === "string",
          )
        : undefined;
      return {
        kind: "conflict",
        headVersion: Number(data?.headVersion ?? 0),
        draftRevision:
          data?.draftRevision === null || data?.draftRevision === undefined
            ? null
            : Number(data.draftRevision),
        conflictingPaths: Array.isArray(data?.conflictingPaths)
          ? (data.conflictingPaths as string[])
          : (conflicts?.map((item) => item.path) ?? []),
        ...(conflicts && conflicts.length > 0 ? { conflicts } : {}),
        message:
          typeof body.msg === "string" && body.msg.trim()
            ? body.msg
            : "云端已更新，请先拉取最新版本",
      };
    }
    if (response.status !== 200) throw new Error(apiError(response, "提交版本失败"));
    const data = (response.body as { data?: Record<string, unknown> }).data ?? {};
    if (data.kind === "merged" || data.kind === "up_to_date") {
      // 服务端已经提交了合并/快进结果；把本地工作区同步到该版本。
      // 拉取失败不回滚云端提交，只把错误带回给调用方（下次 pull 可恢复）。
      let pulled = false;
      let pullError: string | undefined;
      try {
        await this.pull(workspacePath, projectId);
        pulled = true;
      } catch (error) {
        pullError = error instanceof Error ? error.message : String(error);
      }
      if (data.kind === "merged") {
        return {
          kind: "merged",
          revision: Number(data.revision ?? 0),
          baseVersion: Number(data.baseVersion ?? 0),
          parents: Array.isArray(data.parents) ? (data.parents as unknown[]).map(Number) : [],
          mergedPaths: Array.isArray(data.mergedPaths) ? (data.mergedPaths as string[]) : [],
          takenRemotePaths: Array.isArray(data.takenRemotePaths)
            ? (data.takenRemotePaths as string[])
            : [],
          takenLocalPaths: Array.isArray(data.takenLocalPaths)
            ? (data.takenLocalPaths as string[])
            : [],
          pulled,
          ...(pullError ? { pullError } : {}),
        };
      }
      return {
        kind: "up_to_date",
        headVersion: Number(data.headVersion ?? 0),
        pulled,
        ...(pullError ? { pullError } : {}),
      };
    }
    const revision = Number(data.revision ?? 0);
    await writeProjectManifest(workspacePath, {
      projectId,
      serverUrl: this.serverUrl,
      baseVersion: revision,
      baseFiles: files,
      updatedAt: new Date().toISOString(),
    });
    return { kind: "committed", revision, uploadedObjects: uploaded, reusedObjects: reused };
  }

  /** 拉取 head 版本；覆盖/删除前先备份到 `.nibi-project-backups/<时间>/`。 */
  async pull(workspacePath: string, projectId: string): Promise<PullResult> {
    const status = await this.projectStatus(projectId);
    const head = Number(status.headVersion ?? status.project?.headVersion ?? 0);
    if (!head) throw new Error("云端还没有版本");
    const version = await this.getVersion(projectId, head);
    const root = resolve(workspacePath);
    const backupDir = join(root, PROJECT_BACKUP_DIR, new Date().toISOString().replace(/[:.]/gu, "-"));
    let backedUp = 0;
    let written = 0;
    let removed = 0;

    for (const [path, sha] of Object.entries(version.files)) {
      const target = resolve(root, ...path.split("/"));
      if (!target.startsWith(`${root}${sep}`)) throw new Error(`版本路径越界：${path}`);
      let current: string | null = null;
      try {
        current = sha256(new Uint8Array(await readFile(target)));
      } catch {
        current = null;
      }
      if (current === sha) continue;
      if (current !== null) {
        const backup = join(backupDir, ...path.split("/"));
        await mkdir(dirname(backup), { recursive: true });
        await copyFile(target, backup);
        backedUp += 1;
      }
      const downloaded = await this.transport.downloadObject(
        `/api/v1/projects/${projectId}/objects/${sha}`,
      );
      if (downloaded.status !== 200) {
        throw new Error(`下载对象失败（${downloaded.status}）：${path}`);
      }
      const actual = sha256(downloaded.bytes);
      if (actual !== sha) throw new Error(`对象校验失败：${path}`);
      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
      await writeFile(temporary, downloaded.bytes);
      await rename(temporary, target);
      written += 1;
    }

    for (const path of version.deleted) {
      const target = resolve(root, ...path.split("/"));
      if (!target.startsWith(`${root}${sep}`)) continue;
      try {
        const backup = join(backupDir, ...path.split("/"));
        await mkdir(dirname(backup), { recursive: true });
        await copyFile(target, backup);
        backedUp += 1;
        await rm(target, { force: true });
        removed += 1;
      } catch {
        // 本地本来就没有这个文件：删除清单只表示“云端曾经删除过”。
      }
    }

    await writeProjectManifest(workspacePath, {
      projectId,
      serverUrl: this.serverUrl,
      baseVersion: head,
      baseFiles: version.files,
      updatedAt: new Date().toISOString(),
    });
    return { revision: head, written, removed, backupDir: backedUp > 0 ? backupDir : null };
  }

  /**
   * 冲突草稿的逐文件选边：ours=本地(上传时) / theirs=云端(head)。
   * 全部解决后服务端提交 merge 版本，这里自动拉取；仍有冲突时保持 draft，返回剩余项。
   */
  async resolveConflicts(
    workspacePath: string,
    projectId: string,
    revision: number,
    choices: Record<string, ConflictChoice>,
  ): Promise<ResolveConflictResult> {
    const response = await this.transport.request(
      "POST",
      `/api/v1/projects/${projectId}/versions/${revision}/resolve`,
      { choices },
    );
    if (response.status !== 200) throw new Error(apiError(response, "解决冲突失败"));
    const data = (response.body as {
      data?: {
        kind?: string;
        revision?: number;
        resolved?: number;
        conflictsRemaining?: MergeConflictDetail[];
      };
    }).data;
    if (!data || (data.kind !== "merge" && data.kind !== "draft")) {
      throw new Error("解决冲突响应无效");
    }
    let pulled = false;
    let pullError: string | undefined;
    if (data.kind === "merge") {
      try {
        await this.pull(workspacePath, projectId);
        pulled = true;
      } catch (error) {
        pullError = error instanceof Error ? error.message : String(error);
      }
    }
    return {
      kind: data.kind,
      revision: Number(data.revision ?? 0),
      resolved: Number(data.resolved ?? 0),
      conflictsRemaining: Array.isArray(data.conflictsRemaining) ? data.conflictsRemaining : [],
      pulled,
      ...(pullError ? { pullError } : {}),
    };
  }
}

function apiError(response: { status: number; body: unknown }, fallback: string): string {
  const body = response.body as { msg?: unknown; error?: unknown } | null;
  const message =
    typeof body?.msg === "string"
      ? body.msg
      : typeof body?.error === "string"
        ? body.error
        : "";
  return message ? `${fallback}：${message}` : `${fallback}（HTTP ${response.status}）`;
}

export { changedPaths };
