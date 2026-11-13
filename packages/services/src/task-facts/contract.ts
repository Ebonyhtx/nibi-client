import type { NibiTaskMeta, NibiWorkspaceTaskListChanged } from "@nibi/shared";
import type { SessionSummary, SessionsIndexReconcileResult } from "@nibi/shared/nibi-protocol-v4";

export interface TaskWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
}
export interface TaskFactTarget extends TaskWorkspace {
  taskId: string;
}
export type TaskFactMutation = { type: "rename"; title: string } | { type: "delete" };
export interface CliTaskFacts {
  meta: NibiTaskMeta;
  titleSource?: string;
  lastOutcome?: "completed" | "interrupted" | "error";
  deleted?: boolean;
}

/** 存储端口只接受 CLI 事实，不能据 Host 时钟或运行态推导会话事实。 */
export interface TaskFactStore {
  applyCliFacts(facts: CliTaskFacts): Promise<NibiTaskMeta>;
  applyCliDeletion(target: TaskFactTarget): Promise<void>;
  markCliOrphan(target: TaskFactTarget): Promise<void>;
  listReconciliationRows(
    target: TaskWorkspace,
  ): Promise<Array<{ meta: NibiTaskMeta; handoffPending: number; unmaterialized?: boolean }>>;
  getTaskMeta(target: TaskFactTarget): Promise<NibiTaskMeta | null>;
}
export interface TaskFactSource {
  reconcile(target: TaskWorkspace, sessionIds: string[]): Promise<SessionsIndexReconcileResult>;
  execute(target: TaskFactTarget, intent: TaskFactMutation): Promise<void>;
}
export interface TaskFactChange {
  target: TaskFactTarget;
  meta?: NibiTaskMeta;
  reason: NibiWorkspaceTaskListChanged["reason"];
}
export interface TaskFactsContract {
  ingest(target: TaskWorkspace, summary: SessionSummary): Promise<NibiTaskMeta>;
  removed(target: TaskFactTarget): Promise<void>;
  refresh(target: TaskFactTarget): Promise<NibiTaskMeta | null>;
  mutate(target: TaskFactTarget, intent: TaskFactMutation): Promise<NibiTaskMeta | null>;
  reconcile(
    target: TaskWorkspace,
    presentSessionIds: ReadonlySet<string>,
    stillCurrent: () => boolean,
  ): Promise<void>;
}

/** 冷恢复仅按 CLI 身份清理 child 派生索引，不创建运行时或改写会话正文。 */
export interface SubagentIndexRepair {
  target: TaskWorkspace;
  visibleSessionIds: ReadonlySet<string>;
  agentService: {
    listSessions(
      target: TaskWorkspace & { sessionIds: string[]; runtimePolicy: "existing-only" },
    ): Promise<Array<{ sessionId: string; sessionKind?: string; workspace: TaskWorkspace }>>;
  };
  taskIndexRepo: {
    listTaskMetas(target: TaskWorkspace): Promise<Array<{ taskId: string }>>;
    removeSubagentIndexRow(target: TaskFactTarget): Promise<unknown>;
  };
  isCurrent: () => boolean;
  onRemoved: () => void;
}
