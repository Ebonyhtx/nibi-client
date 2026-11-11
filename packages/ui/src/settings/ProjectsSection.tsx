import { useCallback, useMemo, useState } from "react";
import { Database, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { projectDataCleanupAvailable } from "@/project-sidebar/project-data-cleanup.js";
import { useProjectDataCleanupSupport } from "@/project-sidebar/useProjectDataCleanupSupport.js";
import {
  ProjectDirectoryProvider,
  useProjectDirectory,
} from "@/project-sidebar/ProjectDirectoryProvider.js";
import { ProjectDataCleanupDialog } from "@/project-sidebar/ProjectDataCleanupDialog.js";
import { projectKey, projectSourceServerId } from "@/project-sidebar/view.js";
import { remoteHostLabel } from "@/project-sidebar/RemoteHostSection.js";
import { formatDateTime } from "@/settings/automationFormat.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import type {
  ProjectAvailability,
  ProjectTask,
  RemoteProjectHost,
  VirtualProject,
} from "@/project-sidebar/contract.js";

export interface ProjectSettingsRow {
  project: VirtualProject;
  key: string;
  deviceLabel: string;
  /** 远端离线时没有任务事实，显示未知而不是 0。 */
  sessionCount?: number;
  lastActivityAt?: number;
  cleanupAvailable: boolean;
}

function isRunningStatus(status: string): boolean {
  return status === "streaming" || status === "creating" || status === "restoring";
}

/** 设备列优先用 Source 显示名；未注册时回退连接目标，最后才是内部 hostId。 */
export function resolveProjectDeviceLabel(input: {
  project: VirtualProject;
  deviceNames: ReadonlyMap<string, string>;
  hosts: readonly RemoteProjectHost[];
  localLabel: string;
}): string {
  const { project, deviceNames, hosts, localLabel } = input;
  if (project.hostId === "local") return localLabel;
  let sourceServerId: string | undefined;
  try {
    sourceServerId = projectSourceServerId(project);
  } catch {
    // 损坏的历史 host 身份不能拖垮整个项目列表；回退到 hostId/连接目标。
    sourceServerId = undefined;
  }
  const registered = sourceServerId ? deviceNames.get(sourceServerId) : undefined;
  if (registered) return registered;
  const host = hosts.find((candidate) => candidate.id === project.hostId);
  if (host) return remoteHostLabel(host);
  return project.hostId;
}

/**
 * 项目列表的纯投影：会话数与最近活动都取自同一次 readTree 快照。
 * 离线远端项目只能看到入口缓存，不能把缺失任务当成 0 个会话。
 */
export function buildProjectSettingsRows(input: {
  projects: readonly VirtualProject[];
  tasks: readonly ProjectTask[];
  availability: ReadonlyMap<string, ProjectAvailability>;
  deviceNames: ReadonlyMap<string, string>;
  hosts: readonly RemoteProjectHost[];
  localLabel: string;
  cleanupSupported: boolean | "unknown" | undefined;
}): ProjectSettingsRow[] {
  const tasksByProject = new Map<string, ProjectTask[]>();
  for (const task of input.tasks) {
    if (!task.projectId) continue;
    const key = projectKey({ id: task.projectId, hostId: task.hostId });
    const bucket = tasksByProject.get(key);
    if (bucket) bucket.push(task);
    else tasksByProject.set(key, [task]);
  }
  return (
    input.projects
      // 旧单 root 兼容投影不是持久化项目容器，没有可删除/可清理的事实。
      .filter((project) => !project.deleted && project.legacySingleRoot !== true)
      .map((project) => {
        const key = projectKey(project);
        const availability = input.availability.get(key);
        const online = availability?.online !== false;
        const tasks = online ? (tasksByProject.get(key) ?? []) : [];
        // 不用 Math.max(...tasks)：超大项目会把任务数组展开成参数列表并触发调用栈上限。
        let lastActivityAt = project.updatedAt;
        if (online) {
          for (const task of tasks) {
            if (task.updatedAt > lastActivityAt) lastActivityAt = task.updatedAt;
          }
        }
        return {
          project,
          key,
          deviceLabel: resolveProjectDeviceLabel({
            project,
            deviceNames: input.deviceNames,
            hosts: input.hosts,
            localLabel: input.localLabel,
          }),
          ...(online ? { sessionCount: tasks.length } : {}),
          ...(lastActivityAt ? { lastActivityAt } : {}),
          cleanupAvailable:
            online &&
            projectDataCleanupAvailable({
              project,
              supported: input.cleanupSupported,
            }),
        };
      })
  );
}

/** 搜索覆盖名称、全部 root 路径与设备名；排序默认按最近活动倒序。 */
export function filterAndSortProjectSettingsRows(
  rows: readonly ProjectSettingsRow[],
  query: string,
): ProjectSettingsRow[] {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = needle
    ? rows.filter((row) => {
        const haystack = [
          row.project.name,
          ...row.project.roots.map((root) => root.rootPath),
          row.deviceLabel,
        ]
          .join("\n")
          .toLocaleLowerCase();
        return haystack.includes(needle);
      })
    : [...rows];
  return filtered.sort(
    (left, right) =>
      (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0) ||
      left.project.name.localeCompare(right.project.name),
  );
}

function ProjectRowCheckbox({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange(): void;
}) {
  return (
    <Checkbox
      checked={checked}
      aria-label={label}
      onCheckedChange={() => onChange()}
      data-testid="settings-projects-row-checkbox"
    />
  );
}

/**
 * 设置 → 项目：列表、搜索、多选移除与逐项数据清理。
 * 与侧栏共用 ProjectDirectoryProvider 的目录快照，不额外发 RPC；
 * 移除只做项目容器的软删除，不触碰磁盘文件或会话。
 */
export function ProjectsSection({ isDesktop = false }: { isDesktop?: boolean }) {
  return (
    <ProjectDirectoryProvider isDesktop={isDesktop}>
      <ProjectsSectionContent />
    </ProjectDirectoryProvider>
  );
}

function ProjectsSectionContent() {
  const { intl } = useZCodeIntl();
  const directory = useProjectDirectory();
  const { tree, availability, service, remoteService, refresh, loading, error } = directory;
  const confirm = useConfirmDialog();
  const { supported: cleanupSupported, markUnsupported } = useProjectDataCleanupSupport(service);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [cleanupTarget, setCleanupTarget] = useState<VirtualProject | null>(null);

  const runningTaskIds = useZCodeSessionStore((state) => {
    const ids: string[] = [];
    for (const workspace of Object.values(state.workspaces)) {
      for (const [taskId, runtime] of Object.entries(workspace.taskRuntimeByTaskId ?? {})) {
        if (isRunningStatus(runtime.status)) ids.push(taskId);
      }
    }
    return ids.sort().join("\n");
  });
  const runningSessionIds = useMemo(
    () => new Set(runningTaskIds ? runningTaskIds.split("\n") : []),
    [runningTaskIds],
  );

  const rows = useMemo(
    () =>
      buildProjectSettingsRows({
        projects: tree.projects,
        tasks: tree.tasks,
        availability,
        deviceNames: directory.deviceNames,
        hosts: directory.directory.hosts,
        localLabel: intl.formatMessage({ id: "project.thisComputer" }),
        cleanupSupported,
      }),
    [
      availability,
      cleanupSupported,
      directory.deviceNames,
      directory.directory.hosts,
      intl,
      tree.projects,
      tree.tasks,
    ],
  );
  const visibleRows = useMemo(() => filterAndSortProjectSettingsRows(rows, query), [query, rows]);
  const removedRows = useMemo(
    () => tree.projects.filter((project) => project.deleted && project.legacySingleRoot !== true),
    [tree.projects],
  );

  // 选择跨搜索保留：移除按钮作用于全部已选项目，而不是当前筛选后看不见的部分。
  const selectedRows = rows.filter((row) => selected.has(row.key));
  const allVisibleSelected =
    visibleRows.length > 0 && visibleRows.every((row) => selected.has(row.key));
  const someVisibleSelected = visibleRows.some((row) => selected.has(row.key));

  const toggleRow = useCallback((key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const toggleAllVisible = useCallback(() => {
    setSelected((current) => {
      const next = new Set(current);
      if (visibleRows.every((row) => next.has(row.key))) {
        for (const row of visibleRows) next.delete(row.key);
      } else {
        for (const row of visibleRows) next.add(row.key);
      }
      return next;
    });
  }, [visibleRows]);

  /** 复用现有移除命令：离线远端只能移除本机入口，在线项目走所属 Host 的项目软删除。 */
  const removeProject = useCallback(
    async (project: VirtualProject) => {
      const availabilityForProject = availability.get(projectKey(project));
      if (availabilityForProject?.online === false) {
        if (!availabilityForProject.entryId || !remoteService) {
          throw new Error("project.remove-unavailable");
        }
        await remoteService.removeEntry(availabilityForProject.entryId);
        return;
      }
      if (!service) throw new Error("project.service-unavailable");
      await service.deleteProject(project.id, project.hostId);
    },
    [availability, remoteService, service],
  );

  const removeSelected = useCallback(async () => {
    if (busy || selectedRows.length === 0) return;
    const count = selectedRows.length;
    if (
      !(await confirm({
        intent: "settings-projects-remove",
        title: intl.formatMessage({ id: "settings.projects.removeConfirmTitle" }, { count }),
        description: intl.formatMessage({ id: "settings.projects.removeConfirmDescription" }),
        confirmLabel: intl.formatMessage({ id: "settings.projects.removeConfirmAction" }),
        confirmVariant: "destructive",
      }))
    ) {
      return;
    }
    setBusy(true);
    setActionError(null);
    let succeeded = 0;
    const failedKeys = new Set<string>();
    try {
      for (const row of selectedRows) {
        try {
          await removeProject(row.project);
          succeeded += 1;
        } catch (cause) {
          failedKeys.add(row.key);
          logger.warn("[projects-settings] 移除项目失败", {
            projectId: row.project.id,
            hostId: row.project.hostId,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
      await refresh();
      // 失败项保持勾选，用户修好连接后可以直接重试，不必重新搜索选择。
      setSelected(failedKeys);
    } finally {
      setBusy(false);
    }
    const failed = failedKeys.size;
    if (succeeded > 0) {
      toast(intl.formatMessage({ id: "settings.projects.removeSuccess" }, { count: succeeded }));
    }
    if (failed > 0) {
      setActionError(
        intl.formatMessage({ id: "settings.projects.removeFailed" }, { count: failed }),
      );
    }
  }, [busy, confirm, intl, refresh, removeProject, selectedRows]);

  const cleanupTasks = useMemo(() => {
    if (!cleanupTarget) return [];
    return tree.tasks.filter(
      (task) => task.projectId === cleanupTarget.id && task.hostId === cleanupTarget.hostId,
    );
  }, [cleanupTarget, tree.tasks]);

  return (
    <section className="min-w-0 space-y-4" data-testid="settings-projects">
      <p className="text-ui-base leading-6 text-foreground-subtle">
        {intl.formatMessage({ id: "settings.projects.description" })}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <SettingsSearchInput
          containerClassName="min-w-0 flex-1"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => setQuery("")}
          clearLabel={intl.formatMessage({ id: "settings.projects.clearSearch" })}
          placeholder={intl.formatMessage({ id: "settings.projects.searchPlaceholder" })}
          aria-label={intl.formatMessage({ id: "settings.projects.searchLabel" })}
          data-testid="settings-projects-search"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy || selectedRows.length === 0}
          onClick={() => void removeSelected()}
          data-testid="settings-projects-remove"
        >
          <Trash2 className="size-4" aria-hidden="true" />
          {intl.formatMessage(
            { id: "settings.projects.removeSelected" },
            { count: selectedRows.length },
          )}
        </Button>
      </div>
      {actionError ? (
        <p role="alert" className="text-ui-base text-destructive">
          {actionError}
        </p>
      ) : null}
      {error ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-ui-base text-destructive">
            {intl.formatMessage({ id: "settings.projects.loadFailed" })}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
            <RotateCw className="size-4" aria-hidden="true" />
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      ) : null}
      <SettingsGroupCard>
        {loading && rows.length === 0 ? (
          <p className="px-4 py-6 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "common.loading" })}
          </p>
        ) : rows.length === 0 ? (
          <p className="px-4 py-6 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.projects.empty" })}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-2 text-ui-sm font-medium text-foreground-subtle">
              <Checkbox
                checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                aria-label={intl.formatMessage({ id: "settings.projects.selectAll" })}
                onCheckedChange={toggleAllVisible}
                data-testid="settings-projects-select-all"
              />
              <span className="min-w-0 flex-1">
                {intl.formatMessage({ id: "settings.projects.column.name" })}
              </span>
              <span className="hidden w-36 lg:block">
                {intl.formatMessage({ id: "settings.projects.column.device" })}
              </span>
              <span className="hidden w-16 lg:block">
                {intl.formatMessage({ id: "settings.projects.column.sessions" })}
              </span>
              <span className="hidden w-44 lg:block">
                {intl.formatMessage({ id: "settings.projects.column.lastActivity" })}
              </span>
            </div>
            {visibleRows.length === 0 ? (
              <p className="px-4 py-6 text-ui-base text-foreground-subtle">
                {intl.formatMessage({ id: "settings.projects.noResults" })}
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {visibleRows.map((row) => {
                  const primaryPath =
                    row.project.roots.find((root) => root.isPrimary)?.rootPath ??
                    row.project.roots[0]?.rootPath ??
                    "";
                  return (
                    <li
                      key={row.key}
                      className="flex flex-wrap items-center gap-3 px-4 py-3"
                      data-testid="settings-projects-row"
                    >
                      <ProjectRowCheckbox
                        checked={selected.has(row.key)}
                        label={intl.formatMessage(
                          { id: "settings.projects.selectProject" },
                          { name: row.project.name },
                        )}
                        onChange={() => toggleRow(row.key)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-ui-base font-medium text-foreground">
                          {row.project.name}
                        </div>
                        {primaryPath ? (
                          <div className="truncate text-ui-sm text-foreground-subtle">
                            {primaryPath}
                          </div>
                        ) : null}
                      </div>
                      <div className="w-full truncate text-ui-sm text-foreground-subtle lg:w-36">
                        {row.deviceLabel}
                      </div>
                      <div className="w-16 text-ui-sm tabular-nums text-foreground-subtle">
                        {row.sessionCount === undefined ? "—" : row.sessionCount}
                      </div>
                      <div className="flex min-w-0 flex-1 items-center justify-end gap-1 lg:w-44 lg:flex-none lg:justify-between">
                        <span className="truncate text-ui-sm tabular-nums text-foreground-subtle">
                          {row.lastActivityAt ? formatDateTime(row.lastActivityAt) : "—"}
                        </span>
                        {row.cleanupAvailable && service ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={intl.formatMessage({ id: "project.cleanupData" })}
                            title={intl.formatMessage({ id: "project.cleanupData" })}
                            onClick={() => setCleanupTarget(row.project)}
                            data-testid="settings-projects-cleanup"
                          >
                            <Database className="size-4" aria-hidden="true" />
                          </Button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </SettingsGroupCard>
      {removedRows.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "settings.projects.removedTitle" })}
          </h3>
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "settings.projects.removedDescription" })}
          </p>
          <SettingsGroupCard>
            <ul className="divide-y divide-border">
              {removedRows.map((project) => (
                <li
                  key={projectKey(project)}
                  className="flex flex-wrap items-baseline justify-between gap-2 px-4 py-2"
                  data-testid="settings-projects-removed-row"
                >
                  <div className="min-w-0">
                    <div className="truncate text-ui-base text-foreground-subtle">
                      {project.name}
                    </div>
                    <div className="truncate text-ui-sm text-foreground-subtle">
                      {project.roots[0]?.rootPath ?? ""}
                    </div>
                  </div>
                  <span className="rounded-md bg-surface px-2 py-0.5 text-ui-sm text-foreground-subtle">
                    {intl.formatMessage({ id: "settings.projects.removedBadge" })}
                  </span>
                </li>
              ))}
            </ul>
          </SettingsGroupCard>
        </div>
      ) : null}
      {cleanupTarget && service ? (
        <ProjectDataCleanupDialog
          key={`${cleanupTarget.id}:${cleanupTarget.hostId}:cleanup`}
          project={cleanupTarget}
          mode="cleanup"
          service={service}
          tasks={cleanupTasks}
          runningSessionIds={runningSessionIds}
          onClose={() => setCleanupTarget(null)}
          onChanged={refresh}
          onUnsupported={markUnsupported}
        />
      ) : null}
    </section>
  );
}
