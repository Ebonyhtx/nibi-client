// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  IProjectService,
  ProjectDataPurgeDetail,
  ProjectTask,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import { ProjectDataCleanupDialog } from "@/project-sidebar/ProjectDataCleanupDialog.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";

const mock = vi.hoisted(() => ({ locale: "zh-CN" }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: mock.locale,
    intl: {
      formatMessage: ({ id }: { id: string }, values: Record<string, number | string> = {}) =>
        Object.entries(values).reduce(
          (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
          (mock.locale === "zh-CN" ? zhCN : enUS)[id] ?? id,
        ),
    },
  }),
}));
afterEach(cleanup);

const project = {
  id: "p1",
  hostId: "local",
  name: "Project",
  deleted: false,
} as unknown as VirtualProject;

function task(taskId: string, title: string, status?: "running"): ProjectTask {
  return { taskId, title, status } as unknown as ProjectTask;
}

function service(overrides: Partial<IProjectService> = {}) {
  return {
    measureProjectData: vi.fn(async () => ({
      sessions: [
        { sessionId: "safe", bytes: 100 },
        { sessionId: "running", bytes: 200 },
      ],
      directories: [{ path: "/work", memoryBytes: 10, checkpointBytes: 20 }],
    })),
    purgeProjectData: vi.fn(async () => ({
      deleted: [{ sessionId: "safe", bytes: 100 }],
      kept: [{ sessionId: "running", reason: "running" as const }],
      failed: [],
      memory: [{ workspacePath: "/work", bytes: 10 }],
      checkpoints: [{ workspacePath: "/work", bytes: 20 }],
    })),
    deleteProject: vi.fn(async () => {}),
    ...overrides,
  } as unknown as IProjectService;
}

function renderDialog(overrides: {
  mode?: "delete" | "cleanup";
  service?: IProjectService;
  tasks?: ProjectTask[];
  runningSessionIds?: ReadonlySet<string>;
  onClose?: () => void;
  onChanged?: () => Promise<void> | void;
  onUnsupported?: () => void;
}) {
  return render(
    createElement(ProjectDataCleanupDialog, {
      project,
      mode: overrides.mode ?? "cleanup",
      service: overrides.service ?? service(),
      tasks: overrides.tasks ?? [task("safe", "Safe title"), task("running", "Running title")],
      runningSessionIds: overrides.runningSessionIds ?? new Set(["running"]),
      onClose: overrides.onClose ?? (() => {}),
      onChanged: overrides.onChanged ?? (() => {}),
      onUnsupported: overrides.onUnsupported,
    }),
  );
}

describe("项目数据清理对话框", () => {
  it("打开即 measure，运行中不可勾选，确认后只 purge 安全项并逐项展示结果", async () => {
    const api = service();
    const onClose = vi.fn();
    const onChanged = vi.fn();
    renderDialog({ service: api, onClose, onChanged });

    expect(await screen.findByText("清理“Project”的数据")).toBeTruthy();
    expect(api.measureProjectData).toHaveBeenCalledWith("p1");
    const running = screen.getByRole("checkbox", { name: "Running title" });
    expect(running.getAttribute("aria-checked")).toBe("false");
    expect((running as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("运行中")).toBeTruthy();
    const safe = screen.getByRole("checkbox", { name: "Safe title" });
    expect(safe.getAttribute("aria-checked")).toBe("true");
    const directory = screen.getByRole("checkbox", { name: "/work" });
    expect(directory.getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByTestId("project-data-cleanup-primary"));
    expect(await screen.findByTestId("project-data-cleanup-confirm")).toBeTruthy();
    fireEvent.click(screen.getByTestId("project-data-cleanup-confirm-action"));

    await waitFor(() =>
      expect(api.purgeProjectData).toHaveBeenCalledWith({
        projectId: "p1",
        sessionIds: ["safe"],
        directories: ["/work"],
      }),
    );
    expect(await screen.findByTestId("project-data-cleanup-result")).toBeTruthy();
    expect(screen.getByTestId("project-data-cleanup-deleted").textContent).toContain("已删除（1）");
    expect(screen.getByTestId("project-data-cleanup-kept").textContent).toContain("已保留（1）");
    expect(screen.getByTestId("project-data-cleanup-kept").textContent).toContain("运行中");
    expect(onChanged).toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("project-data-cleanup-done"));
    expect(onClose).toHaveBeenCalled();
  });

  it("会话区支持全选/清空，33 条一键选中，部分勾选显示半选", async () => {
    const sessions = Array.from({ length: 33 }, (_, index) => ({
      sessionId: `s${index}`,
      bytes: 0,
    }));
    renderDialog({
      service: service({
        measureProjectData: vi.fn(async () => ({ sessions, directories: [] })),
      }),
      tasks: [],
      runningSessionIds: new Set(),
    });

    const selectAll = await screen.findByTestId("project-data-cleanup-sessions-select-all");
    const count = screen.getByTestId("project-data-cleanup-sessions-selected-count");
    const rowCheckboxes = screen
      .getAllByTestId(/^project-data-cleanup-session-s\d+$/)
      .map((row) => within(row).getByRole("checkbox"));
    expect(rowCheckboxes).toHaveLength(33);
    expect(selectAll.getAttribute("aria-checked")).toBe("false");
    expect(count.textContent).toBe("已选 0 / 共 33");

    fireEvent.click(selectAll);
    expect(selectAll.getAttribute("aria-checked")).toBe("true");
    expect(count.textContent).toBe("已选 33 / 共 33");
    expect(rowCheckboxes.every((box) => box.getAttribute("aria-checked") === "true")).toBe(true);

    fireEvent.click(selectAll);
    expect(selectAll.getAttribute("aria-checked")).toBe("false");
    expect(count.textContent).toBe("已选 0 / 共 33");
    expect(rowCheckboxes.every((box) => box.getAttribute("aria-checked") === "false")).toBe(true);

    fireEvent.click(rowCheckboxes[0]!);
    expect(selectAll.getAttribute("aria-checked")).toBe("mixed");
    expect(count.textContent).toBe("已选 1 / 共 33");
  });

  it("全选只勾选可选会话，运行中会话保持禁用；空会话可一键选中", async () => {
    renderDialog({
      service: service({
        measureProjectData: vi.fn(async () => ({
          sessions: [
            { sessionId: "kept", bytes: 10 },
            { sessionId: "empty-a", bytes: 0 },
            { sessionId: "empty-b", bytes: 0 },
            { sessionId: "running", bytes: 5 },
          ],
          directories: [],
        })),
      }),
      tasks: [],
      runningSessionIds: new Set(["running"]),
    });

    const count = await screen.findByTestId("project-data-cleanup-sessions-selected-count");
    expect(count.textContent).toBe("已选 1 / 共 4");
    const quick = screen.getByTestId("project-data-cleanup-select-empty-sessions");
    expect(quick.textContent).toBe("选择空会话");
    fireEvent.click(quick);
    expect(count.textContent).toBe("已选 3 / 共 4");
    expect(
      screen.getByRole("checkbox", { name: "empty-a" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("checkbox", { name: "empty-b" }).getAttribute("aria-checked"),
    ).toBe("true");

    const selectAll = screen.getByTestId("project-data-cleanup-sessions-select-all");
    expect(selectAll.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(selectAll);
    expect(count.textContent).toBe("已选 0 / 共 4");
    fireEvent.click(selectAll);
    expect(count.textContent).toBe("已选 3 / 共 4");
    const running = screen.getByRole("checkbox", { name: "running" });
    expect(running.getAttribute("aria-checked")).toBe("false");
    expect((running as HTMLButtonElement).disabled).toBe(true);
    expect(selectAll.getAttribute("aria-checked")).toBe("true");
  });

  it("文件夹记忆区支持全选/半选，无空会话时不显示快捷入口", async () => {
    renderDialog({
      service: service({
        measureProjectData: vi.fn(async () => ({
          sessions: [],
          directories: [
            { path: "/a", memoryBytes: 1, checkpointBytes: 0 },
            { path: "/b", memoryBytes: 0, checkpointBytes: 2 },
            { path: "/c", memoryBytes: 0, checkpointBytes: 0 },
          ],
        })),
      }),
      tasks: [],
      runningSessionIds: new Set(),
    });

    const selectAll = await screen.findByTestId("project-data-cleanup-directories-select-all");
    const count = screen.getByTestId("project-data-cleanup-directories-selected-count");
    expect(count.textContent).toBe("已选 2 / 共 3");
    expect(selectAll.getAttribute("aria-checked")).toBe("mixed");

    fireEvent.click(selectAll);
    expect(selectAll.getAttribute("aria-checked")).toBe("true");
    expect(count.textContent).toBe("已选 3 / 共 3");

    fireEvent.click(selectAll);
    expect(selectAll.getAttribute("aria-checked")).toBe("false");
    expect(count.textContent).toBe("已选 0 / 共 3");
    expect(screen.queryByTestId("project-data-cleanup-select-empty-sessions")).toBeNull();
  });

  it("删除项目默认不清理数据；勾选后才显示清单并 purge", async () => {
    const api = service();
    const onClose = vi.fn();
    const { unmount } = renderDialog({ mode: "delete", service: api, onClose });
    expect(await screen.findByText("删除项目“Project”？")).toBeTruthy();
    const option = screen.getByTestId("project-data-cleanup-delete-data");
    expect(option.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByTestId("project-data-cleanup-sessions")).toBeNull();

    fireEvent.click(screen.getByTestId("project-data-cleanup-primary"));
    await waitFor(() => expect(api.deleteProject).toHaveBeenCalledWith("p1", "local"));
    expect(api.purgeProjectData).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    unmount();

    const withData = service();
    renderDialog({ mode: "delete", service: withData });
    await screen.findByTestId("project-data-cleanup-delete-data");
    fireEvent.click(screen.getByTestId("project-data-cleanup-delete-data"));
    expect(await screen.findByTestId("project-data-cleanup-sessions")).toBeTruthy();
    fireEvent.click(screen.getByTestId("project-data-cleanup-primary"));
    fireEvent.click(await screen.findByTestId("project-data-cleanup-confirm-action"));
    await waitFor(() => expect(withData.deleteProject).toHaveBeenCalledWith("p1", "local"));
    await waitFor(() => expect(withData.purgeProjectData).toHaveBeenCalled());
  });

  it("旧内核明确不支持时提示并通知上层隐藏入口", async () => {
    const onUnsupported = vi.fn();
    renderDialog({
      service: service({
        measureProjectData: vi.fn(async () => {
          throw new Error("project.data-unsupported");
        }),
      }),
      onUnsupported,
    });
    expect(await screen.findByTestId("project-data-cleanup-error")).toBeTruthy();
    expect(screen.getByTestId("project-data-cleanup-error").textContent).toContain(
      "当前内核不支持清理项目数据。",
    );
    expect(onUnsupported).toHaveBeenCalledTimes(1);
  });

  it("删除模式测量失败时仍能删除项目，不把旧内核变成删除阻塞", async () => {
    const api = service({
      measureProjectData: vi.fn(async () => {
        throw new Error("project.data-unsupported");
      }),
    });
    const onClose = vi.fn();
    renderDialog({ mode: "delete", service: api, onClose });
    expect(await screen.findByTestId("project-data-cleanup-warning")).toBeTruthy();
    expect(screen.queryByTestId("project-data-cleanup-sessions")).toBeNull();
    fireEvent.click(screen.getByTestId("project-data-cleanup-primary"));
    await waitFor(() => expect(api.deleteProject).toHaveBeenCalledWith("p1", "local"));
    expect(api.purgeProjectData).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("失败项可重试，重试成功后合并结果", async () => {
    const purge = vi
      .fn()
      .mockResolvedValueOnce({
        deleted: [],
        kept: [],
        failed: [{ sessionId: "safe", code: "io" }],
        memory: [],
        checkpoints: [],
      })
      .mockResolvedValueOnce({
        deleted: [{ sessionId: "safe", bytes: 100 }],
        kept: [],
        failed: [],
        memory: [],
        checkpoints: [],
      });
    const api = service({
      purgeProjectData: purge,
      measureProjectData: vi.fn(async () => ({
        sessions: [{ sessionId: "safe", bytes: 100 }],
        directories: [],
      })),
    });
    renderDialog({ service: api, runningSessionIds: new Set() });
    await screen.findByTestId("project-data-cleanup-primary");
    fireEvent.click(screen.getByTestId("project-data-cleanup-primary"));
    fireEvent.click(await screen.findByTestId("project-data-cleanup-confirm-action"));
    expect(await screen.findByTestId("project-data-cleanup-failed")).toBeTruthy();
    fireEvent.click(await screen.findByTestId("project-data-cleanup-retry"));
    await waitFor(() => expect(purge).toHaveBeenCalledTimes(2));
    expect(purge.mock.calls[1]?.[0]).toEqual({
      projectId: "p1",
      sessionIds: ["safe"],
      directories: [],
    });
    await waitFor(() =>
      expect(screen.getByTestId("project-data-cleanup-deleted").textContent).toContain(
        "已删除（1）",
      ),
    );
    expect(screen.queryByTestId("project-data-cleanup-failed")).toBeNull();
  });

  it("重复清理没有可删项时确认按钮禁用（幂等呈现 0 字节）", async () => {
    renderDialog({
      service: service({
        measureProjectData: vi.fn(async () => ({
          sessions: [{ sessionId: "safe", bytes: 0 }],
          directories: [{ path: "/work", memoryBytes: 0, checkpointBytes: 0 }],
        })),
      }),
      runningSessionIds: new Set(),
    });
    const primary = await screen.findByTestId("project-data-cleanup-primary");
    expect((primary as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("运行中")).toBeNull();
  });

  it("保留原因在结果中区分 running 与 referenced", async () => {
    const result: ProjectDataPurgeDetail = {
      deleted: [],
      kept: [
        { sessionId: "a", reason: "running" },
        { sessionId: "b", reason: "referenced" },
      ],
      failed: [],
      memory: [],
      checkpoints: [],
    };
    renderDialog({
      service: service({ purgeProjectData: vi.fn(async () => result) }),
      tasks: [task("a", "A"), task("b", "B")],
      runningSessionIds: new Set(),
    });
    fireEvent.click(await screen.findByTestId("project-data-cleanup-primary"));
    fireEvent.click(await screen.findByTestId("project-data-cleanup-confirm-action"));
    const kept = await screen.findByTestId("project-data-cleanup-kept");
    expect(kept.textContent).toContain("运行中");
    expect(kept.textContent).toContain("仍被引用");
  });

  it("英文文案与中文键都存在，组件不硬编码中文", async () => {
    mock.locale = "en-US";
    try {
      renderDialog({ mode: "delete", service: service() });
      expect(await screen.findByText("Delete project “Project”?")).toBeTruthy();
      expect(screen.getByText("Also delete project data")).toBeTruthy();
    } finally {
      mock.locale = "zh-CN";
    }
  });
});
