import { useCallback, useMemo, useState } from "react";
import { ChevronRight, Database, Folder, RotateCcw, RotateCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
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
import {
  formatDateTime,
  formatRelativeToNow,
  type IntlLike,
} from "@/settings/automationFormat.js";
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

export type ProjectSettingsSort = "lastActivity" | "sessions" | "name";

export interface ProjectSettingsFilterOptions {
  /** 设备列标签；缺省或 "all" 表示不筛选。 */
  deviceLabel?: string;
  sort?: ProjectSettingsSort;
}

/** 搜索覆盖名称、全部 root 路径与设备名；排序默认按最近活动倒序。 */
export function filterAndSortProjectSettingsRows(
  rows: readonly ProjectSettingsRow[],
  query: string,
  options: ProjectSettingsFilterOptions = {},
): ProjectSettingsRow[] {
  const needle = query.trim().toLocaleLowerCase();
  const deviceLabel = options.deviceLabel?.trim();
  const byDevice =
    deviceLabel && deviceLabel !== "all"
      ? rows.filter((row) => row.deviceLabel === deviceLabel)
      : [...rows];
  const filtered = needle
    ? byDevice.filter((row) => {
        const haystack = [
          row.project.name,
          ...row.project.roots.map((root) => root.rootPath),
          row.deviceLabel,
        ]
          .join("\n")
          .toLocaleLowerCase();
        return haystack.includes(needle);
      })
    : byDevice;
  const sort = options.sort ?? "lastActivity";
  return filtered.sort((left, right) => {
    if (sort === "name") {
      return left.project.name.localeCompare(right.project.name);
    }
    if (sort === "sessions") {
      // 离线远端的会话数未知：排在已知值之后，而不是当成 0 混进最前面。
      return (
        (right.sessionCount ?? -1) - (left.sessionCount ?? -1) ||
        left.project.name.localeCompare(right.project.name)
      );
    }
    return (
      (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0) ||
      left.project.name.localeCompare(right.project.name)
    );
  });
}

/**
 * 已移除项目的「N 前移除」文案。
 * 删除动作会把 updatedAt 与 deleted_at 一起写成当前时间，所以这里用 updatedAt 作为移除时刻；
 * 不新增 RPC，也不伪造缺失的时间事实。
 */
export function formatProjectRemovedAgo(
  timestamp: number | undefined,
  now: number,
  intl: IntlLike,
): string {
  // 没有删除时间事实时显示占位符，不能拼出“-移除”这种半截文案。
  if (!timestamp) return "—";
  return intl.formatMessage(
    { id: "settings.projects.removedAgo" },
    { time: formatRelativeToNow(timestamp, now, intl) },
  );
}

/** 表头与数据行共用的列模板：勾选、项目（含路径）、设备、会话、最近活动。 */
const PROJECT_ROW_GRID =
  "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-4 lg:grid-cols-[auto_minmax(0,1fr)_9rem_4rem_11rem]";

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
  const [deviceFilter, setDeviceFilter] = useState("all");
  const [sortBy, setSortBy] = useState<ProjectSettingsSort>("lastActivity");
  const [removedOpen, setRemovedOpen] = useState(true);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [restoringKey, setRestoringKey] = useState<string | null>(null);
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
  const visibleRows = useMemo(
    () => filterAndSortProjectSettingsRows(rows, query, { deviceLabel: deviceFilter, sort: sortBy }),
    [deviceFilter, query, rows, sortBy],
  );
  // 设备筛选只投影当前仍在侧栏的项目，设备顺序按名称稳定排列。
  const deviceOptions = useMemo(
    () =>
      [...new Set(rows.map((row) => row.deviceLabel))].sort((left, right) =>
        left.localeCompare(right),
      ),
    [rows],
  );
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

  /**
   * 恢复走与 ProjectEditor 相同的服务路径：saveProject({ restoreProjectId, roots })。
   * 项目软删除后 roots 仍完整保留，原样回传即可通过 restore-roots-mismatch 校验；
   * 远端项目由 service 内部按 hostId 路由到所属 Host，失败（离线 / 目录已不存在）如实显示。
   */
  const restoreProject = useCallback(
    async (project: VirtualProject) => {
      if (!service || restoringKey !== null) return;
      const key = projectKey(project);
      setRestoringKey(key);
      setActionError(null);
      try {
        await service.saveProject({
          hostId: project.hostId,
          restoreProjectId: project.id,
          roots: project.roots.map((root) => root.rootPath),
        });
        await refresh();
        toast(
          intl.formatMessage({ id: "settings.projects.restoreSuccess" }, { name: project.name }),
        );
      } catch (cause) {
        logger.warn("[projects-settings] 恢复项目失败", {
          projectId: project.id,
          hostId: project.hostId,
          error: cause instanceof Error ? cause.message : String(cause),
        });
        setActionError(
          intl.formatMessage({ id: "settings.projects.restoreFailed" }, { name: project.name }),
        );
      } finally {
        setRestoringKey(null);
      }
    },
    [intl, refresh, restoringKey, service],
  );

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
      {/* 搜索、设备筛选与排序同一行：上游把三者视作列表的工具栏，不做三段式分组。 */}
      <div className="flex flex-col gap-2 md:flex-row md:items-center">
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
        <div className="flex flex-wrap items-center gap-2">
          <Select value={deviceFilter} onValueChange={setDeviceFilter}>
            <SelectTrigger
              size="lg"
              className="h-9 w-full justify-between rounded-xl md:w-40"
              aria-label={intl.formatMessage({ id: "settings.projects.deviceFilter.label" })}
              data-testid="settings-projects-device-filter"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectItem value="all">
                {intl.formatMessage({ id: "settings.projects.deviceFilter.all" })}
              </SelectItem>
              {deviceOptions.map((label) => (
                <SelectItem key={label} value={label}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={sortBy}
            onValueChange={(value) => setSortBy(value as ProjectSettingsSort)}
          >
            <SelectTrigger
              size="lg"
              className="h-9 w-full justify-between rounded-xl md:w-36"
              aria-label={intl.formatMessage({ id: "settings.projects.sort.label" })}
              data-testid="settings-projects-sort"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectItem value="lastActivity">
                {intl.formatMessage({ id: "settings.projects.sort.lastActivity" })}
              </SelectItem>
              <SelectItem value="sessions">
                {intl.formatMessage({ id: "settings.projects.sort.sessions" })}
              </SelectItem>
              <SelectItem value="name">
                {intl.formatMessage({ id: "settings.projects.sort.name" })}
              </SelectItem>
            </SelectContent>
          </Select>
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
            {/* 表头与行共用同一套 grid 列宽，窄窗口只保留勾选与项目两列。 */}
            <div
              className={cn(
                PROJECT_ROW_GRID,
                "border-b border-border py-2 text-ui-sm font-medium text-foreground-subtle",
              )}
            >
              <Checkbox
                checked={allVisibleSelected ? true : someVisibleSelected ? "indeterminate" : false}
                aria-label={intl.formatMessage({ id: "settings.projects.selectAll" })}
                onCheckedChange={toggleAllVisible}
                data-testid="settings-projects-select-all"
              />
              <span className="min-w-0">
                {intl.formatMessage({ id: "settings.projects.column.name" })}
              </span>
              <span className="hidden lg:block">
                {intl.formatMessage({ id: "settings.projects.column.device" })}
              </span>
              <span className="hidden lg:block">
                {intl.formatMessage({ id: "settings.projects.column.sessions" })}
              </span>
              <span className="hidden lg:block">
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
                      className={cn(
                        PROJECT_ROW_GRID,
                        "py-2.5 transition-colors hover:bg-surface-hover",
                      )}
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
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Folder
                          className="size-4 shrink-0 text-foreground-subtle"
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <div className="truncate text-ui-base font-medium text-foreground">
                            {row.project.name}
                          </div>
                          {primaryPath ? (
                            <div className="truncate text-ui-sm text-foreground-subtle">
                              {primaryPath}
                            </div>
                          ) : null}
                        </div>
                      </div>
                      <div className="hidden truncate text-ui-sm text-foreground-subtle lg:block">
                        {row.deviceLabel}
                      </div>
                      <div className="hidden text-ui-sm tabular-nums text-foreground-subtle lg:block">
                        {row.sessionCount === undefined ? "—" : row.sessionCount}
                      </div>
                      <div className="col-start-2 flex min-w-0 items-center justify-between gap-1 lg:col-start-auto">
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
          <button
            type="button"
            aria-expanded={removedOpen}
            aria-controls="settings-projects-removed-list"
            onClick={() => setRemovedOpen((open) => !open)}
            className="flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left transition-colors hover:bg-surface-hover"
            data-testid="settings-projects-removed-toggle"
          >
            <ChevronRight
              className={cn(
                "size-3.5 shrink-0 text-foreground-subtle transition-transform",
                removedOpen && "rotate-90",
              )}
              aria-hidden="true"
            />
            <span className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.projects.removedTitle" })}
            </span>
            <span className="rounded-md bg-surface px-1.5 py-0.5 text-ui-sm tabular-nums text-foreground-subtle">
              {removedRows.length}
            </span>
          </button>
          {removedOpen ? (
            <>
              <p className="px-1 text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "settings.projects.removedDescription" })}
              </p>
              <SettingsGroupCard>
                <ul id="settings-projects-removed-list" className="divide-y divide-border">
                  {removedRows.map((project) => (
                    <li
                      key={projectKey(project)}
                      className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
                      data-testid="settings-projects-removed-row"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Folder
                          className="size-4 shrink-0 text-foreground-subtle"
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <div className="truncate text-ui-base text-foreground">
                            {project.name}
                          </div>
                          <div className="truncate text-ui-sm text-foreground-subtle">
                            {project.roots[0]?.rootPath ?? ""}
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <span className="text-ui-sm tabular-nums text-foreground-subtle">
                          {formatProjectRemovedAgo(project.updatedAt, Date.now(), intl)}
                        </span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={!service || restoringKey !== null}
                          onClick={() => void restoreProject(project)}
                          data-testid="settings-projects-restore"
                        >
                          <RotateCcw
                            className={cn(
                              "size-3.5",
                              restoringKey === projectKey(project) && "animate-spin",
                            )}
                            aria-hidden="true"
                          />
                          {intl.formatMessage({ id: "settings.projects.restore" })}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </SettingsGroupCard>
            </>
          ) : null}
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
