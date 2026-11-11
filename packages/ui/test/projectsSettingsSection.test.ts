import { describe, expect, it } from "vitest";
import type {
  ProjectAvailability,
  ProjectTask,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import {
  buildProjectSettingsRows,
  filterAndSortProjectSettingsRows,
  formatProjectRemovedAgo,
  resolveProjectDeviceLabel,
} from "@/settings/ProjectsSection.js";

const testIntl = {
  formatMessage: ({ id }: { id: string }, values?: Record<string, string>) =>
    values
      ? `${id}:${Object.entries(values)
          .map(([key, value]) => `${key}=${value}`)
          .join(",")}`
      : id,
};

function makeProject(overrides: Partial<VirtualProject> = {}): VirtualProject {
  return {
    id: "project-1",
    hostId: "local",
    name: "Alpha",
    nameOverridden: false,
    roots: [{ rootPath: "/work/alpha", position: 0, isPrimary: true }],
    position: 0,
    pinned: false,
    deleted: false,
    createdAt: 10,
    updatedAt: 100,
    ...overrides,
  };
}

function makeTask(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    taskId: "task-1",
    traceId: "trace-1",
    title: "Task",
    workspacePath: "/work/alpha",
    createdAt: 10,
    updatedAt: 50,
    mode: "default",
    projectId: "project-1",
    hostId: "local",
    pinned: false,
    archived: false,
    ...overrides,
  } as unknown as ProjectTask;
}

function buildRows(input?: {
  projects?: VirtualProject[];
  tasks?: ProjectTask[];
  availability?: Map<string, ProjectAvailability>;
}) {
  return buildProjectSettingsRows({
    projects: input?.projects ?? [makeProject()],
    tasks: input?.tasks ?? [],
    availability: input?.availability ?? new Map(),
    deviceNames: new Map(),
    hosts: [],
    localLabel: "This computer",
    cleanupSupported: true,
  });
}

describe("buildProjectSettingsRows", () => {
  it("排除已移除项目与旧单 root 投影，并统计会话数与最近活动", () => {
    const rows = buildRows({
      projects: [
        makeProject(),
        makeProject({ id: "deleted", deleted: true }),
        makeProject({ id: "legacy", legacySingleRoot: true }),
      ],
      tasks: [
        makeTask({ taskId: "a", updatedAt: 200 }),
        makeTask({ taskId: "b", updatedAt: 150, archived: true }),
      ],
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionCount).toBe(2);
    expect(rows[0]?.lastActivityAt).toBe(200);
    expect(rows[0]?.cleanupAvailable).toBe(true);
  });

  it("远端离线时保留项目行但会话数未知，且不提供本机清理", () => {
    const remote = makeProject({
      id: "remote-project",
      hostId: "remote:docker:build-box",
      name: "Remote",
      roots: [{ rootPath: "/srv/remote", position: 0, isPrimary: true }],
      updatedAt: 0,
    });
    const rows = buildRows({
      projects: [remote],
      tasks: [makeTask({ projectId: "remote-project", hostId: "remote:docker:build-box" })],
      availability: new Map([
        [JSON.stringify(["remote:docker:build-box", "remote-project"]), { online: false }],
      ]),
    });

    expect(rows[0]?.sessionCount).toBeUndefined();
    expect(rows[0]?.lastActivityAt).toBeUndefined();
    expect(rows[0]?.cleanupAvailable).toBe(false);
    expect(rows[0]?.deviceLabel).toBe("remote:docker:build-box");
  });

  it("本机设备统一显示「此电脑」标签", () => {
    expect(
      resolveProjectDeviceLabel({
        project: makeProject(),
        deviceNames: new Map(),
        hosts: [],
        localLabel: "此电脑",
      }),
    ).toBe("此电脑");
  });
});

describe("filterAndSortProjectSettingsRows", () => {
  const rows = buildRows({
    projects: [
      makeProject({ id: "a", name: "Alpha", updatedAt: 100 }),
      makeProject({
        id: "b",
        hostId: "remote:docker:build-box",
        name: "Beta",
        roots: [{ rootPath: "/srv/beta", position: 0, isPrimary: true }],
        updatedAt: 0,
      }),
    ],
    tasks: [
      makeTask({ taskId: "a1", projectId: "a", updatedAt: 100 }),
      makeTask({
        taskId: "b1",
        projectId: "b",
        hostId: "remote:docker:build-box",
        updatedAt: 300,
      }),
    ],
  });

  it("默认按最近活动倒序", () => {
    expect(filterAndSortProjectSettingsRows(rows, "").map((row) => row.project.name)).toEqual([
      "Beta",
      "Alpha",
    ]);
  });

  it("搜索覆盖项目名、路径与设备名", () => {
    expect(filterAndSortProjectSettingsRows(rows, "alpha")).toHaveLength(1);
    expect(filterAndSortProjectSettingsRows(rows, "/srv/beta")[0]?.project.name).toBe("Beta");
    expect(filterAndSortProjectSettingsRows(rows, "build-box")).toHaveLength(1);
    expect(filterAndSortProjectSettingsRows(rows, "missing")).toHaveLength(0);
  });

  it("按设备标签筛选，all 表示不过滤", () => {
    expect(
      filterAndSortProjectSettingsRows(rows, "", { deviceLabel: "Beta 所在设备" }),
    ).toHaveLength(0);
    expect(
      filterAndSortProjectSettingsRows(rows, "", { deviceLabel: "remote:docker:build-box" }).map(
        (row) => row.project.name,
      ),
    ).toEqual(["Beta"]);
    expect(
      filterAndSortProjectSettingsRows(rows, "", { deviceLabel: "all" }).map(
        (row) => row.project.name,
      ),
    ).toEqual(["Beta", "Alpha"]);
  });

  it("支持按名称与最近活动排序", () => {
    expect(
      filterAndSortProjectSettingsRows(rows, "", { sort: "name" }).map((row) => row.project.name),
    ).toEqual(["Alpha", "Beta"]);
    expect(
      filterAndSortProjectSettingsRows(rows, "", { sort: "lastActivity" }).map(
        (row) => row.project.name,
      ),
    ).toEqual(["Beta", "Alpha"]);
  });
});

describe("formatProjectRemovedAgo", () => {
  it("用相对时间拼出「N 前移除」，未知时间不编造具体时长", () => {
    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
    expect(formatProjectRemovedAgo(threeDaysAgo, Date.now(), testIntl)).toContain(
      "settings.projects.removedAgo:time=",
    );
    expect(formatProjectRemovedAgo(threeDaysAgo, Date.now(), testIntl)).toContain(
      "automations.time.days",
    );
    expect(formatProjectRemovedAgo(undefined, Date.now(), testIntl)).toBe("—");
  });
});
