// 归档会话的永久删除（v4/storage/sessionData/deletionPreview|deletionExecute）。
// 预检只读库、列文件、问运行时占用；执行在写删除凭据之后再核对一次，删文件、删行。
// 存储面的 SQL 在 adapters 的 sessions 仓库（凭据 session_purge，迁移 0026）；这里只做编排。
//
// 与旧的 sessionData/purge（项目数据清理）是两条路径：purge 是字节统计与尽力清理，
// 这里按删除凭据走，删除中/删完的会话不会再出现在列表里。
import { createHash } from "node:crypto";
import {
  SessionDeletionError,
  type SessionArtifactReference,
  type SessionDeletionBeginInput,
  type SessionDeletionBeginOutcome,
  type SessionDeletionScope,
  type SessionDeletionTitledSession,
  type SessionId,
  type SessionInfo,
} from "@nibi/contracts";
import {
  SessionDataFileError,
  listSessionFiles,
  removeSession,
  type SessionDataFile,
} from "@nibi/adapters";
import {
  v4SessionDeletionExecuteParamsSchema,
  v4SessionDeletionPreviewParamsSchema,
  type V4SessionDeletionBlockReason,
  type V4SessionDeletionExecuteResult,
  type V4SessionDeletionPreviewResult,
  type V4SessionDeletionRetainedArtifact,
  type V4SessionDeletionTitled,
  type V4SessionDeletionWorkspace,
} from "@nibi/shared/nibi-protocol-v4";
import { parseParams, type NibiProtocolAgentServerContext } from "../server-types.js";

interface DeletionStore {
  getSession(sessionID: SessionId): Promise<SessionInfo | null>;
  inspectSessionDeletion(rootID: SessionId): Promise<SessionDeletionScope>;
  beginSessionDeletion(
    rootID: SessionId,
    input: SessionDeletionBeginInput,
  ): Promise<SessionDeletionBeginOutcome>;
  completeSessionDeletion(rootID: SessionId): Promise<void>;
  hasSessionRuntimePresence?(sessionIDs: readonly SessionId[]): Promise<boolean>;
  getCliStorageRoot?(): string;
}

function asSessionId(value: string): SessionId {
  return value as SessionId;
}

interface PreviewState {
  preview: V4SessionDeletionPreviewResult;
  scope: SessionDeletionScope;
}

function deletionStore(context: NibiProtocolAgentServerContext): DeletionStore {
  const store = context.deps.sessionStore;
  if (
    !store ||
    typeof store.inspectSessionDeletion !== "function" ||
    typeof store.beginSessionDeletion !== "function" ||
    typeof store.completeSessionDeletion !== "function"
  ) {
    throw new Error("session permanent deletion is not implemented by this session store");
  }
  return store as unknown as DeletionStore;
}

function cliStorageRoot(context: NibiProtocolAgentServerContext, store: DeletionStore): string {
  const root = context.deps.cliStorageRoot ?? store.getCliStorageRoot?.();
  if (!root) throw new SessionDeletionError("session-data.unavailable");
  return root;
}

/** 会话自己的 workspace identity 与 Host 声明不一致时，什么都不做（前置条件拒绝）。 */
async function assertWorkspaceIdentity(
  store: DeletionStore,
  sessionID: string,
  workspace: V4SessionDeletionWorkspace,
): Promise<void> {
  if (workspace.workspaceIdentity === undefined) return;
  const session = await store.getSession(asSessionId(sessionID));
  if (!session) return;
  const identity = session.workspaceID ? String(session.workspaceID) : null;
  if (identity !== workspace.workspaceIdentity) {
    throw new SessionDeletionError("session-data.identity-mismatch");
  }
}

function titled(sessions: readonly SessionDeletionTitledSession[]): V4SessionDeletionTitled[] {
  return sessions.map((session) => ({
    sessionId: String(session.sessionID),
    title: session.title,
  }));
}

function retainedArtifacts(
  references: readonly SessionArtifactReference[],
  files: ReadonlyMap<string, SessionDataFile[]>,
): V4SessionDeletionRetainedArtifact[] {
  const retained: V4SessionDeletionRetainedArtifact[] = [];
  for (const reference of references) {
    const referrers = titled(reference.referrers);
    const matches = (files.get(String(reference.sessionID)) ?? []).filter(
      (file) => file.artifact && file.name.includes(reference.artifactID),
    );
    if (matches.length === 0) {
      retained.push({
        sessionId: String(reference.sessionID),
        artifactId: reference.artifactID,
        fileName: reference.artifactID,
        referrers,
      });
      continue;
    }
    for (const file of matches) {
      retained.push({
        sessionId: String(reference.sessionID),
        artifactId: reference.artifactID,
        fileName: file.name,
        referrers,
      });
    }
  }
  return retained;
}

function blockedReason(
  workspace: V4SessionDeletionWorkspace,
  scope: SessionDeletionScope,
  inUse: boolean,
): V4SessionDeletionBlockReason | undefined {
  if (scope.workspace && scope.workspace.workspacePath !== workspace.workspacePath)
    return "unavailable";
  if (inUse || scope.pendingWork) return "running";
  if (scope.sessionIDs.length === 0) return "not_found";
  return undefined;
}

function revisionDigest(input: {
  scope: SessionDeletionScope;
  files: ReadonlyMap<string, SessionDataFile[]>;
  blocked: V4SessionDeletionBlockReason | undefined;
}): string {
  const files = [...input.files.entries()].flatMap(([, sessionFiles]) =>
    sessionFiles.map((file) => [file.relativePath, file.bytes] as const),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        stamps: input.scope.stamps.map((stamp) => ({
          sessionId: String(stamp.sessionID),
          updatedAt: stamp.updatedAt,
          deletedAt: stamp.deletedAt,
        })),
        forks: titled(input.scope.forks),
        references: input.scope.references.map((reference) => ({
          sessionId: String(reference.sessionID),
          artifactId: reference.artifactID,
          referrers: titled(reference.referrers),
        })),
        files,
        blocked: input.blocked ?? null,
      }),
    )
    .digest("hex");
}

/** 预检与执行共用：一次读范围、列每个会话的文件、问运行时占用，再算 revision。 */
async function inspect(
  context: NibiProtocolAgentServerContext,
  sessionID: string,
  workspace: V4SessionDeletionWorkspace,
): Promise<PreviewState> {
  const store = deletionStore(context);
  await assertWorkspaceIdentity(store, sessionID, workspace);
  const root = cliStorageRoot(context, store);
  const scope = await store.inspectSessionDeletion(asSessionId(sessionID));
  const files = new Map<string, SessionDataFile[]>();
  for (const id of scope.sessionIDs) {
    files.set(String(id), await listSessionFiles(root, String(id)));
  }
  const liveInProcess = scope.sessionIDs.some((id) => context.sessions?.has(String(id)) ?? false);
  const inUse =
    liveInProcess ||
    (scope.sessionIDs.length > 0
      ? ((await store.hasSessionRuntimePresence?.(scope.sessionIDs)) ?? false)
      : false);
  const blocked = blockedReason(workspace, scope, inUse);
  const retained = retainedArtifacts(scope.references, files);
  const preview: V4SessionDeletionPreviewResult = {
    sessionId: sessionID,
    revision: revisionDigest({ scope, files, blocked }),
    sessionIds: scope.sessionIDs.map(String),
    forks: titled(scope.forks),
    retainedArtifacts: retained,
    deletedFiles: countDeletedFiles(scope, files, retained),
    ...(blocked ? { blockedReason: blocked } : {}),
    incomplete: scope.receipt === "deleting",
    completed: scope.receipt === "deleted",
  };
  return { preview, scope };
}

function countDeletedFiles(
  scope: SessionDeletionScope,
  files: ReadonlyMap<string, SessionDataFile[]>,
  retained: readonly V4SessionDeletionRetainedArtifact[],
): number {
  const kept = new Set(retained.map((entry) => `${entry.sessionId}\u0000${entry.fileName}`));
  let deleted = 0;
  for (const id of scope.sessionIDs) {
    for (const file of files.get(String(id)) ?? []) {
      if (!kept.has(`${String(id)}\u0000${file.name}`)) deleted++;
    }
  }
  return deleted;
}

function resultOf(
  sessionID: string,
  state: PreviewState,
  status: V4SessionDeletionExecuteResult["status"],
  reason?: string,
): V4SessionDeletionExecuteResult {
  return {
    sessionId: sessionID,
    status,
    sessionIds: state.scope.sessionIDs.map(String),
    retainedArtifacts: state.preview.retainedArtifacts.length,
    ...(reason ? { reason } : {}),
  };
}

export async function previewSessionDeletion(
  context: NibiProtocolAgentServerContext,
  params: unknown,
): Promise<V4SessionDeletionPreviewResult> {
  const input = parseParams(v4SessionDeletionPreviewParamsSchema, params);
  return (await inspect(context, input.sessionId, input.workspace)).preview;
}

export async function executeSessionDeletion(
  context: NibiProtocolAgentServerContext,
  params: unknown,
): Promise<V4SessionDeletionExecuteResult> {
  const input = parseParams(v4SessionDeletionExecuteParamsSchema, params);
  const store = deletionStore(context);
  const root = cliStorageRoot(context, store);
  const first = await inspect(context, input.sessionId, input.workspace);
  if (first.preview.completed) return resultOf(input.sessionId, first, "deleted");
  if (first.preview.blockedReason)
    return resultOf(input.sessionId, first, "blocked", first.preview.blockedReason);
  // 删到一半（凭据 deleting）时接着删，不再比确认时的 revision。
  if (!first.preview.incomplete && first.preview.revision !== input.revision) {
    return resultOf(input.sessionId, first, "blocked", "changed");
  }
  const outcome = await store.beginSessionDeletion(asSessionId(input.sessionId), {
    operationID: input.operationId,
    stamps: first.scope.stamps,
    retained: first.preview.retainedArtifacts.map((entry) => ({
      sessionID: asSessionId(entry.sessionId),
      artifactID: entry.artifactId,
    })),
  });
  if (outcome === "changed") return resultOf(input.sessionId, first, "blocked", "changed");
  if (outcome === "running") return resultOf(input.sessionId, first, "blocked", "running");
  // 凭据已经插下：再读一次，保留附件以凭据里记的为准（引用方在开删后也写不进来）。
  const now = await inspect(context, input.sessionId, input.workspace);
  // 先删文件：删不掉时凭据留着，重试接着删。
  for (const sessionID of now.scope.sessionIDs) {
    const keep = now.preview.retainedArtifacts
      .filter((entry) => entry.sessionId === String(sessionID))
      .map((entry) => entry.artifactId);
    try {
      await removeSession(root, String(sessionID), [...new Set(keep)]);
    } catch (error) {
      return resultOf(input.sessionId, now, "incomplete", errorCode(error));
    }
  }
  try {
    await store.completeSessionDeletion(asSessionId(input.sessionId));
  } catch (error) {
    return resultOf(input.sessionId, now, "incomplete", errorCode(error));
  }
  return resultOf(input.sessionId, now, "deleted");
}

function errorCode(error: unknown): string {
  if (error instanceof SessionDataFileError) return error.code;
  if (error instanceof SessionDeletionError) return error.code;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  )
    return (error as { code: string }).code;
  return error instanceof Error ? error.message : String(error);
}
