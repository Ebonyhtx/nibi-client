import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import type {
  IProjectService,
  ProjectDataPurgeDetail,
  ProjectTask,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import {
  buildProjectDataCleanupRows,
  isProjectDataUnsupportedError,
  mergeProjectDataPurgeResults,
  projectDataCleanupFreedBytes,
  projectDataCleanupRetrySelection,
  projectDataCleanupSelection,
  type ProjectDataCleanupRows,
} from "@/project-sidebar/project-data-cleanup.js";
import { formatBytes } from "@/resource-manager/resourceUsageView.js";
import { logger } from "@/logger.js";

type Phase = "loading" | "select" | "confirm" | "working" | "result" | "error";

/**
 * 项目数据清理：打开时 measure，默认勾选非运行中且有字节的会话与目录；
 * 运行中的会话不可勾选并显示原因；purge 后逐项展示 deleted / kept / failed（可重试）。
 *
 * mode="delete" 时先软删除项目容器，再按用户选择清理数据（数据可选，默认不删）；
 * mode="cleanup" 只清理数据，项目容器保留。两种情况都不删除正在运行/被引用的会话。
 */
export function ProjectDataCleanupDialog({
  project,
  mode,
  service,
  tasks,
  runningSessionIds,
  onClose,
  onChanged,
  onUnsupported,
}: {
  project: VirtualProject;
  mode: "delete" | "cleanup";
  service: IProjectService;
  tasks: readonly ProjectTask[];
  runningSessionIds: ReadonlySet<string>;
  onClose(): void;
  onChanged(): Promise<void> | void;
  onUnsupported?(): void;
}) {
  const { intl } = useNibiIntl();
  const msg = (id: string, values?: Record<string, string | number>) =>
    intl.formatMessage({ id: `project.${id}` }, values);
  const [phase, setPhase] = useState<Phase>("loading");
  const [rows, setRows] = useState<ProjectDataCleanupRows | null>(null);
  const [deleteData, setDeleteData] = useState(false);
  const [result, setResult] = useState<ProjectDataPurgeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 测量只在打开时跑一次；任务与运行态由 ref 提供最新值，避免父级刷新导致反复测量。
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const runningRef = useRef(runningSessionIds);
  runningRef.current = runningSessionIds;
  const alive = useRef(true);
  const onUnsupportedRef = useRef(onUnsupported);
  onUnsupportedRef.current = onUnsupported;

  const formatError = (cause: unknown) => {
    if (isProjectDataUnsupportedError(cause)) {
      onUnsupportedRef.current?.();
      return msg("cleanupUnsupported");
    }
    const text = cause instanceof Error ? cause.message : String(cause);
    // 端口缺失/远端拒绝与「旧内核不支持」对用户是同一件事：本机数据面不可用。
    if (text.includes("project.data-unavailable") || text.includes("project.data-local-only")) {
      onUnsupportedRef.current?.();
      return msg("cleanupUnsupported");
    }
    return text || msg("cleanupLoadFailed");
  };
  const formatErrorRef = useRef(formatError);
  formatErrorRef.current = formatError;

  useEffect(() => {
    alive.current = true;
    setPhase("loading");
    void service
      .measureProjectData(project.id)
      .then((measured) => {
        if (!alive.current) return;
        setRows(
          buildProjectDataCleanupRows({
            measured,
            tasks: tasksRef.current,
            runningSessionIds: runningRef.current,
          }),
        );
        setPhase("select");
      })
      .catch((cause) => {
        if (!alive.current) return;
        logger.warn("[project-data] 测量失败", cause);
        const message = formatErrorRef.current(cause);
        setError(message);
        // 删除项目是既有能力：旧内核或数据面不可用时只隐藏可选清理，不能因此阻止删除。
        if (mode === "delete") {
          setRows({ sessions: [], directories: [] });
          setPhase("select");
          return;
        }
        setPhase("error");
      });
    return () => {
      alive.current = false;
    };
  }, [project.id, service, mode]);

  const toggleSession = (sessionId: string) => {
    setRows((current) =>
      current
        ? {
            ...current,
            sessions: current.sessions.map((row) =>
              row.sessionId === sessionId && !row.running
                ? { ...row, selected: !row.selected }
                : row,
            ),
          }
        : current,
    );
  };
  const toggleDirectory = (path: string) => {
    setRows((current) =>
      current
        ? {
            ...current,
            directories: current.directories.map((row) =>
              row.path === path ? { ...row, selected: !row.selected } : row,
            ),
          }
        : current,
    );
  };

  // 全选只作用于可选中的行：运行中会话由内核保留，不能因全选被带上。
  const setAllSessionsSelected = (next: boolean | "indeterminate") => {
    const selected = next === true;
    setRows((current) =>
      current
        ? {
            ...current,
            sessions: current.sessions.map((row) => (row.running ? row : { ...row, selected })),
          }
        : current,
    );
  };
  const setAllDirectoriesSelected = (next: boolean | "indeterminate") => {
    const selected = next === true;
    setRows((current) =>
      current
        ? {
            ...current,
            directories: current.directories.map((row) => ({ ...row, selected })),
          }
        : current,
    );
  };
  const selectEmptySessions = () => {
    setRows((current) =>
      current
        ? {
            ...current,
            sessions: current.sessions.map((row) =>
              !row.running && row.bytes === 0 ? { ...row, selected: true } : row,
            ),
          }
        : current,
    );
  };

  const sessionRows = rows?.sessions ?? [];
  const selectableSessions = sessionRows.filter((row) => !row.running);
  const selectedSessionCount = selectableSessions.filter((row) => row.selected).length;
  const sessionsSelectAllState: boolean | "indeterminate" =
    selectableSessions.length > 0 && selectedSessionCount === selectableSessions.length
      ? true
      : selectedSessionCount > 0
        ? "indeterminate"
        : false;

  const directoryRows = rows?.directories ?? [];
  const selectedDirectoryCount = directoryRows.filter((row) => row.selected).length;
  const directoriesSelectAllState: boolean | "indeterminate" =
    directoryRows.length > 0 && selectedDirectoryCount === directoryRows.length
      ? true
      : selectedDirectoryCount > 0
        ? "indeterminate"
        : false;

  // 空会话默认未勾选（没有字节可释放），是「33 条要点 33 次」的主要来源。
  const emptySessions = sessionRows.filter((row) => !row.running && row.bytes === 0);
  const hasEmptySessions = emptySessions.length > 0;
  const hasUnselectedEmptySessions = emptySessions.some((row) => !row.selected);

  const selection = rows
    ? projectDataCleanupSelection(rows)
    : { sessionIds: [], directories: [], totalBytes: 0 };
  const hasSelection = selection.sessionIds.length > 0 || selection.directories.length > 0;
  const willPurge = mode === "cleanup" || (deleteData && hasSelection);

  const run = async () => {
    setPhase("working");
    setError(null);
    try {
      if (mode === "delete") {
        await service.deleteProject(project.id, project.hostId);
        await onChanged();
      }
      if (willPurge) {
        const purged = await service.purgeProjectData({
          projectId: project.id,
          sessionIds: selection.sessionIds,
          directories: selection.directories,
        });
        setResult(purged);
        await onChanged();
        setPhase("result");
        return;
      }
      onClose();
    } catch (cause) {
      logger.warn("[project-data] 清理失败", cause);
      setError(formatError(cause));
      setPhase("error");
    }
  };

  const retryFailed = async () => {
    if (!result) return;
    const retry = projectDataCleanupRetrySelection(result);
    if (!retry.sessionIds.length && !retry.directories.length) return;
    setError(null);
    try {
      const next = await service.purgeProjectData({
        projectId: project.id,
        sessionIds: retry.sessionIds,
        directories: retry.directories,
      });
      setResult(mergeProjectDataPurgeResults(result, next));
      await onChanged();
    } catch (cause) {
      logger.warn("[project-data] 重试清理失败", cause);
      setError(formatError(cause));
    }
  };

  const title =
    phase === "result"
      ? msg("cleanupResultTitle")
      : mode === "delete"
        ? msg("deleteConfirmTitle", { name: project.name })
        : msg("cleanupTitle", { name: project.name });
  const description =
    phase === "result"
      ? msg("cleanupResultDescription", {
          size: formatBytes(result ? projectDataCleanupFreedBytes(result) : 0),
        })
      : mode === "delete"
        ? msg("deleteConfirmDescription")
        : msg("cleanupDescription");

  const selectable = phase === "select";
  const retrySelection = result
    ? projectDataCleanupRetrySelection(result)
    : { sessionIds: [], directories: [] };
  const hasRetry = retrySelection.sessionIds.length > 0 || retrySelection.directories.length > 0;
  const showDataList =
    Boolean(rows) &&
    (mode === "cleanup" || deleteData) &&
    (selectable || phase === "confirm" || phase === "working");

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open && phase !== "working") onClose();
      }}
    >
      <AlertDialogContent data-testid="project-data-cleanup" className="max-w-xl">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        {phase === "loading" ? (
          <div className="flex items-center gap-2 py-6 text-ui-base text-foreground-subtle">
            <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
            {intl.formatMessage({ id: "common.loading" })}
          </div>
        ) : null}

        {phase === "error" ? (
          <p
            role="alert"
            data-testid="project-data-cleanup-error"
            className="text-ui-base text-destructive"
          >
            {error}
          </p>
        ) : null}

        {phase === "select" && error ? (
          <p data-testid="project-data-cleanup-warning" className="text-ui-sm text-warning">
            {error}
          </p>
        ) : null}

        {rows && (phase === "select" || phase === "confirm" || phase === "working") ? (
          <>
            {mode === "delete" && (rows.sessions.length > 0 || rows.directories.length > 0) ? (
              <div className="flex items-start gap-2 rounded-lg border border-border bg-surface/60 p-3">
                <Checkbox
                  data-testid="project-data-cleanup-delete-data"
                  aria-label={msg("cleanupDeleteDataOption")}
                  checked={deleteData}
                  disabled={phase !== "select"}
                  onCheckedChange={(value) => setDeleteData(value === true)}
                />
                <span className="min-w-0">
                  <span className="block text-ui-base text-foreground">
                    {msg("cleanupDeleteDataOption")}
                  </span>
                  <span className="block text-ui-sm text-foreground-subtle">
                    {rows.sessions.length || rows.directories.length
                      ? msg("cleanupDeleteDataHint", {
                          sessions: rows.sessions.length,
                          size: formatBytes(
                            rows.sessions.reduce((sum, row) => sum + row.bytes, 0) +
                              rows.directories.reduce(
                                (sum, row) => sum + row.memoryBytes + row.checkpointBytes,
                                0,
                              ),
                          ),
                        })
                      : msg("cleanupEmpty")}
                  </span>
                </span>
              </div>
            ) : null}

            {showDataList ? (
              <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
                <section data-testid="project-data-cleanup-sessions">
                  <div className="mb-1 flex min-h-6 flex-wrap items-center gap-2">
                    <Checkbox
                      data-testid="project-data-cleanup-sessions-select-all"
                      aria-label={msg("cleanupSelectAllSessions")}
                      checked={sessionsSelectAllState}
                      disabled={phase !== "select" || selectableSessions.length === 0}
                      onCheckedChange={setAllSessionsSelected}
                    />
                    <h3 className="text-ui-sm font-medium text-foreground-subtle">
                      {msg("cleanupSessions", { count: rows.sessions.length })}
                    </h3>
                    <span
                      data-testid="project-data-cleanup-sessions-selected-count"
                      className="text-ui-sm tabular-nums text-foreground-subtle"
                    >
                      {msg("cleanupSelectionCount", {
                        selected: selectedSessionCount,
                        total: sessionRows.length,
                      })}
                    </span>
                    {hasEmptySessions ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="ml-auto text-foreground-subtle"
                        data-testid="project-data-cleanup-select-empty-sessions"
                        disabled={phase !== "select" || !hasUnselectedEmptySessions}
                        onClick={selectEmptySessions}
                      >
                        {msg("cleanupSelectEmptySessions")}
                      </Button>
                    ) : null}
                  </div>
                  {rows.sessions.length === 0 ? (
                    <p className="text-ui-sm text-foreground-subtle">{msg("cleanupNoSessions")}</p>
                  ) : (
                    <ul className="divide-y divide-border rounded-lg border border-border">
                      {rows.sessions.map((row) => (
                        <li
                          key={row.sessionId}
                          data-testid={`project-data-cleanup-session-${row.sessionId}`}
                          className="flex items-center gap-2 px-3 py-2"
                        >
                          <Checkbox
                            aria-label={row.title}
                            checked={row.running ? false : row.selected}
                            disabled={row.running || phase !== "select"}
                            onCheckedChange={() => toggleSession(row.sessionId)}
                          />
                          <span className="min-w-0 flex-1 truncate text-ui-base">{row.title}</span>
                          {row.running ? (
                            <span className="shrink-0 text-ui-sm text-warning">
                              {msg("cleanupRunning")}
                            </span>
                          ) : null}
                          <span className="shrink-0 text-ui-sm tabular-nums text-foreground-subtle">
                            {formatBytes(row.bytes)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                <section data-testid="project-data-cleanup-directories">
                  <div className="mb-1 flex min-h-6 flex-wrap items-center gap-2">
                    <Checkbox
                      data-testid="project-data-cleanup-directories-select-all"
                      aria-label={msg("cleanupSelectAllDirectories")}
                      checked={directoriesSelectAllState}
                      disabled={phase !== "select" || directoryRows.length === 0}
                      onCheckedChange={setAllDirectoriesSelected}
                    />
                    <h3 className="text-ui-sm font-medium text-foreground-subtle">
                      {msg("cleanupDirectories", { count: rows.directories.length })}
                    </h3>
                    <span
                      data-testid="project-data-cleanup-directories-selected-count"
                      className="text-ui-sm tabular-nums text-foreground-subtle"
                    >
                      {msg("cleanupSelectionCount", {
                        selected: selectedDirectoryCount,
                        total: directoryRows.length,
                      })}
                    </span>
                  </div>
                  {rows.directories.length === 0 ? (
                    <p className="text-ui-sm text-foreground-subtle">
                      {msg("cleanupNoDirectories")}
                    </p>
                  ) : (
                    <ul className="divide-y divide-border rounded-lg border border-border">
                      {rows.directories.map((row) => (
                        <li
                          key={row.path}
                          data-testid={`project-data-cleanup-directory-${row.path}`}
                          className="flex items-center gap-2 px-3 py-2"
                        >
                          <Checkbox
                            aria-label={row.path}
                            checked={row.selected}
                            disabled={phase !== "select"}
                            onCheckedChange={() => toggleDirectory(row.path)}
                          />
                          <span className="min-w-0 flex-1 truncate text-ui-base" title={row.path}>
                            {row.path}
                          </span>
                          <span className="shrink-0 text-ui-sm tabular-nums text-foreground-subtle">
                            {formatBytes(row.memoryBytes + row.checkpointBytes)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {phase === "confirm" ? (
                  <p data-testid="project-data-cleanup-confirm" className="text-ui-base">
                    {msg("cleanupConfirmSummary", {
                      sessions: selection.sessionIds.length,
                      size: formatBytes(selection.totalBytes),
                    })}
                  </p>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}

        {phase === "result" && result ? (
          <div
            data-testid="project-data-cleanup-result"
            className="max-h-[50vh] space-y-3 overflow-y-auto pr-1 text-ui-base"
          >
            <p className="font-medium">
              {msg("cleanupFreed", { size: formatBytes(projectDataCleanupFreedBytes(result)) })}
            </p>
            <section data-testid="project-data-cleanup-deleted">
              <h3 className="text-ui-sm font-medium text-foreground-subtle">
                {msg("cleanupDeleted", { count: result.deleted.length })}
              </h3>
              <ul>
                {result.deleted.map((entry) => (
                  <li key={entry.sessionId} className="flex justify-between gap-2 py-0.5">
                    <span className="min-w-0 truncate">{entry.sessionId}</span>
                    <span className="shrink-0 text-foreground-subtle">
                      {formatBytes(entry.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            <section data-testid="project-data-cleanup-kept">
              <h3 className="text-ui-sm font-medium text-foreground-subtle">
                {msg("cleanupKept", { count: result.kept.length })}
              </h3>
              <ul>
                {result.kept.map((entry) => (
                  <li key={entry.sessionId} className="flex justify-between gap-2 py-0.5">
                    <span className="min-w-0 truncate">{entry.sessionId}</span>
                    <span className="shrink-0 text-warning">
                      {msg(
                        entry.reason === "running"
                          ? "cleanupReasonRunning"
                          : "cleanupReasonReferenced",
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
            {result.failed.length ? (
              <section data-testid="project-data-cleanup-failed">
                <h3 className="text-ui-sm font-medium text-foreground-subtle">
                  {msg("cleanupFailed", { count: result.failed.length })}
                </h3>
                <ul>
                  {result.failed.map((entry, index) => (
                    <li key={`${entry.sessionId ?? entry.workspacePath ?? index}-${index}`}>
                      <span className="min-w-0 truncate">
                        {entry.sessionId ?? entry.workspacePath}
                      </span>
                      <span className="ml-2 text-ui-sm text-destructive">{entry.code}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {error ? (
              <p role="alert" className="text-ui-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}

        <AlertDialogFooter>
          {phase === "result" ? (
            <>
              {hasRetry ? (
                <AlertDialogCancel
                  data-testid="project-data-cleanup-retry"
                  onClick={(event) => {
                    event.preventDefault();
                    void retryFailed();
                  }}
                >
                  {intl.formatMessage({ id: "common.retry" })}
                </AlertDialogCancel>
              ) : null}
              <AlertDialogAction data-testid="project-data-cleanup-done" onClick={onClose}>
                {msg("cleanupDone")}
              </AlertDialogAction>
            </>
          ) : phase === "error" ? (
            <>
              <AlertDialogCancel data-testid="project-data-cleanup-cancel" onClick={onClose}>
                {intl.formatMessage({ id: "common.close" })}
              </AlertDialogCancel>
              <AlertDialogAction
                data-testid="project-data-cleanup-retry"
                onClick={(event) => {
                  event.preventDefault();
                  void run();
                }}
              >
                {intl.formatMessage({ id: "common.retry" })}
              </AlertDialogAction>
            </>
          ) : phase === "confirm" ? (
            <>
              <AlertDialogCancel
                data-testid="project-data-cleanup-back"
                onClick={(event) => {
                  event.preventDefault();
                  setPhase("select");
                }}
              >
                {msg("cleanupBack")}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                data-testid="project-data-cleanup-confirm-action"
                onClick={(event) => {
                  event.preventDefault();
                  void run();
                }}
              >
                {mode === "delete" ? msg("cleanupDeleteWithData") : msg("cleanupConfirmAction")}
              </AlertDialogAction>
            </>
          ) : (
            <>
              <AlertDialogCancel
                data-testid="project-data-cleanup-cancel"
                disabled={phase === "working"}
                onClick={(event) => {
                  event.preventDefault();
                  onClose();
                }}
              >
                {intl.formatMessage({ id: "common.cancel" })}
              </AlertDialogCancel>
              <AlertDialogAction
                variant={mode === "delete" ? "destructive" : "default"}
                data-testid="project-data-cleanup-primary"
                disabled={phase !== "select" || (mode === "cleanup" && !hasSelection)}
                onClick={(event) => {
                  event.preventDefault();
                  if (mode === "delete" && (!deleteData || !hasSelection)) {
                    void run();
                    return;
                  }
                  setPhase("confirm");
                }}
              >
                {phase === "working" ? (
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                ) : null}
                {mode === "delete"
                  ? deleteData && hasSelection
                    ? msg("cleanupDeleteWithData")
                    : msg("deleteConfirmAction")
                  : msg("cleanupConfirmAction")}
              </AlertDialogAction>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
