import { useRef, useState } from "react";
import type {
  NibiArchivedTaskDeletionPreview,
  ProjectTask,
} from "@/project-sidebar/contract.js";
import { useProjectDirectory } from "@/project-sidebar/ProjectDirectoryProvider.js";
import {
  mutateProjectTask,
  permanentlyDeleteProjectTask,
  previewProjectTaskDeletion,
} from "@/project-sidebar/task-mutation.js";
import { archiveTaskKey } from "@/project-sidebar/archive-view.js";
import { findArchiveTaskRowRect, playNibiFeatherFallFromRect } from "@/lib/nibiFeatherFall.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { resolveRemoteWorkspaceSessionIdForTarget } from "@/hooks/useResolvedRemoteWorkspaceSessionId.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useNibiSessionStore } from "@/store/nibiSessionStore.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

export type ArchiveOperation = "unarchive" | "delete";

export interface ArchiveOperationResult {
  succeeded: number;
  failed: number;
  skipped: number;
  /** CLI 已删掉一部分但未完成；保留在列表中，可用“继续删除”重试。 */
  incomplete: number;
}

interface PreviewEntry {
  task: ProjectTask;
  preview?: NibiArchivedTaskDeletionPreview;
  error?: unknown;
}

const PREVIEW_CONCURRENCY = 4;

function createOperationId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `archive-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Map<number, R>();
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results.set(index, await fn(items[index]!));
    }
  });
  await Promise.all(workers);
  return items.map((_, index) => results.get(index)!);
}

export function useArchiveManagement() {
  const directory = useProjectDirectory();
  const { nibiTaskService: service, windowControllerService: controller } =
    useBaseWorkspaceServices();
  const removeTaskState = useNibiSessionStore((s) => s.removeTaskState);
  const confirm = useConfirmDialog();
  const { intl } = useNibiIntl();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ArchiveOperationResult | null>(null);
  const [resumable, setResumable] = useState<ProjectTask[]>([]);
  const locked = useRef(false);
  const latest = useRef(directory);
  latest.current = directory;

  const msg = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `archives.${id}` }, values);

  const previewTask = async (task: ProjectTask): Promise<PreviewEntry> => {
    const remoteSessionId = resolveRemoteWorkspaceSessionIdForTarget({
      ...task,
      state: useRemoteWorkspaceSessionStore.getState(),
    });
    try {
      return {
        task,
        preview: await previewProjectTaskDeletion({ service, controller }, task, remoteSessionId),
      };
    } catch (error) {
      logger.error("[archive-management] 永久删除预检失败", {
        taskId: task.taskId,
        workspaceIdentity: task.workspaceIdentity,
        error,
      });
      return { task, error };
    }
  };

  const collectPreviews = (tasks: ProjectTask[]) =>
    mapLimit(tasks, PREVIEW_CONCURRENCY, previewTask);

  const formatPreviewDescription = (entries: PreviewEntry[]): string => {
    const actionable = entries.filter((entry) => entry.preview && !entry.preview.blockedReason);
    const deletable = actionable.filter((entry) => !entry.preview!.completed);
    const completed = actionable.filter((entry) => entry.preview!.completed);
    const blocked = entries.filter((entry) => !entry.preview || entry.preview.blockedReason);
    const sessions = deletable.reduce((sum, entry) => sum + entry.preview!.sessionIds.length, 0);
    const forks = deletable.reduce((sum, entry) => sum + entry.preview!.forks.length, 0);
    const artifacts = deletable.reduce(
      (sum, entry) => sum + entry.preview!.retainedArtifacts.length,
      0,
    );
    const lines: string[] = [];
    if (deletable.length > 0) {
      lines.push(msg("previewWillDelete", { tasks: deletable.length, sessions }));
      if (forks > 0 || artifacts > 0)
        lines.push(msg("previewWillKeep", { forks, artifacts }));
      if (deletable.some((entry) => entry.preview!.incomplete))
        lines.push(msg("previewIncomplete"));
    }
    if (completed.length > 0) lines.push(msg("previewCompleted", { count: completed.length }));
    if (blocked.length > 0) {
      const reasons = [
        ...new Set(blocked.map((entry) => entry.preview?.blockedReason ?? "unavailable")),
      ];
      lines.push(
        msg("previewCannotDelete", {
          count: blocked.length,
          reasons: reasons.map((reason) => msg(`previewBlocked.${reason}`)).join(", "),
        }),
      );
    }
    return lines.join("\n");
  };

  const run = async (
    tasks: ProjectTask[],
    operation: ArchiveOperation,
    originRect?: DOMRect,
  ) => {
    if (locked.current || !tasks.length) return;
    // 固定确认时的身份集合；搜索变化、新归档和重复点击不能扩充已经确认的批次。
    const candidates = [
      ...new Map(tasks.filter((t) => t.archived).map((t) => [archiveTaskKey(t), t])).values(),
    ];
    if (!candidates.length) return;
    locked.current = true;
    setBusy(true);
    setResult(null);
    setResumable([]);
    const counts: ArchiveOperationResult = { succeeded: 0, failed: 0, skipped: 0, incomplete: 0 };
    try {
      if (operation === "unarchive") {
        for (const task of candidates) {
          if (
            !latest.current.tree.tasks.some(
              (t) => archiveTaskKey(t) === archiveTaskKey(task) && t.archived,
            )
          ) {
            counts.skipped++;
            continue;
          }
          try {
            const remoteSessionId = resolveRemoteWorkspaceSessionIdForTarget({
              ...task,
              state: useRemoteWorkspaceSessionStore.getState(),
            });
            await mutateProjectTask(
              { service, controller },
              task,
              { kind: "archive", archived: false },
              remoteSessionId,
            );
            counts.succeeded++;
          } catch (error) {
            counts.failed++;
            logger.error("[archive-management] 任务操作失败", {
              taskId: task.taskId,
              workspaceIdentity: task.workspaceIdentity,
              operation,
              error,
            });
          }
        }
        await latest.current.refresh();
        setResult(counts);
        return;
      }

      let previews: PreviewEntry[] = [];
      const confirmed = await confirm({
        intent: "archive-management-delete",
        title: intl.formatMessage({ id: "archives.deleteTitle" }, { count: candidates.length }),
        description: msg("preparing"),
        confirmLabel: msg("deletePermanently"),
        confirmVariant: "destructive",
        prepare: async () => {
          previews = await collectPreviews(candidates);
          return {
            description: formatPreviewDescription(previews),
            confirmDisabled: !previews.some(
              (entry) => entry.preview && !entry.preview.blockedReason,
            ),
          };
        },
      });
      if (!confirmed) return;
      if (previews.length === 0) previews = await collectPreviews(candidates);

      // 确认后再取行位置，避免确认期间列表滚动/过滤导致飘羽起点过期；折叠组没有行，用触发按钮兜底。
      const featherRects = new Map<string, DOMRect>();
      for (const entry of previews) {
        const rect = findArchiveTaskRowRect(entry.task.taskId);
        if (rect) featherRects.set(archiveTaskKey(entry.task), rect);
      }
      let fallbackFeatherPlayed = false;
      const incompleteTasks: ProjectTask[] = [];

      for (const entry of previews) {
        const { task, preview } = entry;
        if (
          !latest.current.tree.tasks.some(
            (t) => archiveTaskKey(t) === archiveTaskKey(task) && t.archived,
          )
        ) {
          counts.skipped++;
          continue;
        }
        if (!preview || preview.blockedReason) {
          counts.failed++;
          continue;
        }
        try {
          const remoteSessionId = resolveRemoteWorkspaceSessionIdForTarget({
            ...task,
            state: useRemoteWorkspaceSessionStore.getState(),
          });
          const outcome = await permanentlyDeleteProjectTask(
            { service, controller },
            task,
            preview.revision,
            createOperationId(),
            remoteSessionId,
          );
          if (outcome.status === "deleted") {
            removeTaskState(task.workspacePath, task.taskId, task.workspaceIdentity);
            const key = archiveTaskKey(task);
            const rect = featherRects.get(key) ?? (!fallbackFeatherPlayed ? originRect : undefined);
            if (rect && !featherRects.has(key)) fallbackFeatherPlayed = true;
            playNibiFeatherFallFromRect(rect);
            counts.succeeded++;
          } else if (outcome.status === "incomplete") {
            // 行必须保留：下一次预检会返回 incomplete，确认后从断点续删。
            counts.incomplete++;
            incompleteTasks.push(task);
          } else {
            counts.failed++;
          }
        } catch (error) {
          counts.failed++;
          logger.error("[archive-management] 永久删除失败", {
            taskId: task.taskId,
            workspaceIdentity: task.workspaceIdentity,
            error,
          });
        }
      }
      await latest.current.refresh();
      setResult(counts);
      setResumable(incompleteTasks);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  };

  return {
    ...directory,
    busy,
    result,
    resumable,
    resume: () => {
      if (resumable.length === 0) return;
      void run(resumable, "delete");
    },
    run,
  };
}
