// 项目菜单 → Worktrees 管理弹窗。列表每次打开都向本机 Host 重新读取；
// 删除/清理后同样重新读取，不在 UI 侧推算结果。
import { GitBranch, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ManagedWorktreeEntry, ManagedWorktreeGroup, ManagedWorktreeTaskRef } from "./contract.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Spinner } from "@/components/ui/spinner.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { cn } from "@/components/lib/utils.js";
import { formatManagedWorktreeError } from "./managedWorktreeErrors.js";

function pathLeaf(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).at(-1) ?? path;
}

export function ManagedWorktreesDialog({
  projectId,
  projectName,
  onClose,
  onOpenTask,
}: {
  projectId: string;
  projectName: string;
  onClose: () => void;
  onOpenTask: (task: ManagedWorktreeTaskRef) => void;
}) {
  const { intl } = useNibiIntl();
  const msg = (id: string) => intl.formatMessage({ id: `git.managedWorktree.dialog.${id}` });
  const managedWorktreeService = useOptionalBaseWorkspaceServices()?.managedWorktreeService;
  const confirm = useConfirmDialog();
  const [groups, setGroups] = useState<ManagedWorktreeGroup[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [pruneBusy, setPruneBusy] = useState(false);

  const reload = useCallback(async () => {
    if (!managedWorktreeService) return;
    setLoading(true);
    setLoadError(null);
    try {
      setGroups((await managedWorktreeService.listWorktrees({ projectId })).groups);
    } catch (error) {
      logger.warn("[worktree] 读取 worktree 列表失败", { error });
      setLoadError(formatManagedWorktreeError(intl, error));
    } finally {
      setLoading(false);
    }
  }, [intl, managedWorktreeService, projectId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const remove = async (entry: ManagedWorktreeEntry) => {
    if (!managedWorktreeService) return;
    const force = entry.dirty === true && entry.tasks.length === 0;
    const confirmed = await confirm({
      title: msg("deleteConfirmTitle"),
      description: force ? msg("deleteConfirmDirty") : msg("deleteConfirmDescription"),
      confirmLabel: msg("delete"),
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    setBusyPath(entry.path);
    setRowErrors((current) => ({ ...current, [entry.path]: "" }));
    try {
      const result = await managedWorktreeService.removeWorktree({
        projectId,
        path: entry.path,
        ...(force ? { force: true } : {}),
      });
      if (!result.ok) {
        // 删除被拒绝时保留目录与任务，只在行内展示原因。
        const message =
          result.error.code === "worktree-in-use"
            ? msg(`error.${result.error.detail === "terminal" ? "terminal" : "running"}`)
            : result.error.code === "worktree-dirty"
              ? msg("error.dirty")
              : msg("error.generic");
        setRowErrors((current) => ({ ...current, [entry.path]: message }));
        return;
      }
      await reload();
    } catch (error) {
      logger.warn("[worktree] 删除 worktree 失败", { error });
      toast(msg("error.generic"));
    } finally {
      setBusyPath(null);
    }
  };

  const prune = async (group: ManagedWorktreeGroup) => {
    if (!managedWorktreeService) return;
    setPruneBusy(true);
    try {
      await managedWorktreeService.pruneWorktrees({ projectId, sourceRoot: group.sourceRoot });
      await reload();
    } catch (error) {
      logger.warn("[worktree] 清理 worktree 记录失败", { error });
      toast(msg("pruneFailed"));
    } finally {
      setPruneBusy(false);
    }
  };

  const visibleGroups = (groups ?? []).filter((group) => group.worktrees.length > 0);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="max-h-[calc(100vh-4rem)] w-full max-w-2xl grid-rows-[auto_minmax(0,1fr)] gap-3">
        <DialogHeader>
          <DialogTitle>{msg("title")}</DialogTitle>
          <DialogDescription>
            {msg("description")} · {projectName}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-ui-sm text-foreground-subtle">{msg("managedByNibi")}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={loading}
              onClick={() => void reload()}
            >
              <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
              {msg("refresh")}
            </Button>
          </div>
          {loadError ? (
            <p role="alert" className="text-ui-sm text-destructive">
              {loadError}
            </p>
          ) : null}
          <div className="min-h-0 overflow-y-auto rounded-lg border border-border">
            {loading && groups === null ? (
              <div className="flex items-center justify-center gap-2 py-10 text-ui-sm text-foreground-subtle">
                <Spinner className="size-4" />
                {intl.formatMessage({ id: "common.loading" })}
              </div>
            ) : visibleGroups.length === 0 ? (
              <p className="py-10 text-center text-ui-sm text-foreground-subtle">
                {msg("empty")}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {visibleGroups.flatMap((group) =>
                  group.worktrees.map((worktree) => (
                    <li
                      key={worktree.path}
                      data-testid="managed-worktree-row"
                      data-state={worktree.state}
                      className="flex min-w-0 flex-col gap-2 px-3 py-2.5"
                    >
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="min-w-0 break-all text-ui-base font-medium text-foreground">
                          {pathLeaf(worktree.sourceRoot)} · {worktree.bucket}
                        </span>
                        {worktree.state === "missing" ? (
                          <Badge variant="secondary">{msg("missing")}</Badge>
                        ) : null}
                        {worktree.dirty ? (
                          <Badge variant="destructive">{msg("dirty")}</Badge>
                        ) : null}
                      </div>
                      <span className="min-w-0 truncate font-mono text-ui-sm text-foreground-subtle">
                        {worktree.branchName ?? worktree.head?.slice(0, 7) ?? msg("detached")}
                      </span>
                      <span className="min-w-0 truncate font-mono text-ui-sm text-foreground-subtlest">
                        {worktree.path}
                      </span>
                      <div className="flex min-w-0 flex-wrap items-center gap-1">
                        {worktree.tasks.map((task) => (
                          <Button
                            key={`${task.workspacePath}:${task.taskId}`}
                            type="button"
                            size="sm"
                            variant="outline"
                            className="min-w-0"
                            onClick={() => onOpenTask(task)}
                          >
                            <GitBranch className="size-3.5" />
                            <span className="min-w-0 truncate">
                              {task.title || msg("untitledTask")}
                            </span>
                          </Button>
                        ))}
                        {worktree.state === "missing" ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={pruneBusy}
                            onClick={() => void prune(group)}
                          >
                            {msg("prune")}
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="text-foreground-subtle hover:text-destructive"
                            disabled={busyPath === worktree.path || worktree.creating}
                            onClick={() => void remove(worktree)}
                          >
                            {busyPath === worktree.path ? (
                              <Spinner className="size-3.5" />
                            ) : (
                              <Trash2 className="size-3.5" />
                            )}
                            {msg("delete")}
                          </Button>
                        )}
                      </div>
                      {rowErrors[worktree.path] ? (
                        <p role="alert" className="text-ui-sm text-destructive">
                          {rowErrors[worktree.path]}
                        </p>
                      ) : null}
                    </li>
                  )),
                )}
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}