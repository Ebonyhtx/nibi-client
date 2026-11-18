// @vitest-environment jsdom
import { act, createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { GitRepositorySummary, NibiTaskMeta } from "@nibi/shared";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { TaskRowIdentityHoverCard } from "@/task-row-hover/index.js";
import type { TaskRowIdentityHoverCardProps } from "@/task-row-hover/contract.js";

const mockIntl = vi.hoisted(() => ({ locale: "en-US" as "en-US" | "zh-CN" }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useNibiIntl: () => ({
    locale: mockIntl.locale,
    intl: {
      formatMessage: ({ id }: { id: string }, values: Record<string, string | number> = {}) =>
        Object.entries(values).reduce(
          (text, [key, value]) => text.replaceAll(`{${key}}`, String(value)),
          (mockIntl.locale === "zh-CN" ? zhCN : enUS)[id] ?? id,
        ),
    },
  }),
}));

const fake = vi.hoisted(() => {
  const info = vi.fn();
  const git = vi.fn();
  return {
    info,
    git,
    services: {
      systemService: { info },
      gitService: { getRepositorySummary: git },
    },
    remote: null as unknown,
  };
});

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => fake.services,
  useWorkspaceServices: () => fake.services,
  useWorkspaceServicesResolution: () => fake.remote,
}));

class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;

  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? "";
  }
}

beforeAll(() => vi.stubGlobal("PointerEvent", TestPointerEvent));
beforeEach(() => {
  mockIntl.locale = "en-US";
  fake.info.mockResolvedValue({ homedir: "/home/dev" });
  fake.git.mockResolvedValue(gitSummary());
  fake.remote = {
    services: fake.services,
    rpcReady: true,
    remoteSessionId: "remote-session",
    isRemoteTarget: true,
    connectionKind: "remote-ready",
  };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function gitSummary(overrides: Partial<GitRepositorySummary> = {}): GitRepositorySummary {
  return {
    workspacePath: "/home/dev/project",
    repoRoot: "/home/dev/project",
    workspaceInRepoPath: "",
    autoRefreshWatchPaths: [],
    branchName: "main",
    trackingBranchName: null,
    headRefType: "branch",
    ahead: 0,
    behind: 0,
    isDirty: false,
    isGitAvailable: true,
    isRepository: true,
    ...overrides,
  };
}

function task(overrides: Partial<NibiTaskMeta> = {}): NibiTaskMeta {
  return {
    taskId: "task-1",
    traceId: "trace-1",
    title: "Task",
    workspacePath: "/home/dev/project",
    createdAt: 1,
    updatedAt: Date.now() - 60_000,
    mode: "default",
    ...overrides,
  };
}

function mount(overrides: Partial<TaskRowIdentityHoverCardProps> = {}) {
  return render(
    createElement(TaskRowIdentityHoverCard, {
      task: task(),
      workspaceLabel: "project",
      children: createElement("button", { type: "button" }, "task row"),
      ...overrides,
    }),
  );
}

async function openCard(): Promise<HTMLElement> {
  fireEvent.pointerEnter(screen.getByText("task row"), { pointerType: "mouse" });
  return screen.findByTestId("task-row-details");
}

function waitForHoverDelay() {
  return act(() => new Promise((resolve) => setTimeout(resolve, 350)));
}

it("延迟打开并显示任务路径与最近活动，指针离开行后关闭", async () => {
  mount();
  const row = screen.getByText("task row");
  expect(screen.queryByTestId("task-row-details")).toBeNull();

  fireEvent.pointerEnter(row, { pointerType: "mouse" });
  expect(screen.queryByTestId("task-row-details")).toBeNull();

  const details = await screen.findByTestId("task-row-details");
  await waitFor(() => expect(details.textContent).toContain("~/project"));
  expect(details.textContent).toContain("Last active");

  fireEvent.pointerLeave(row, { pointerType: "mouse" });
  await waitFor(() => expect(screen.queryByTestId("task-row-details")).toBeNull());
});

it("行名为空时回退到 workspacePath 叶子，并显示任务自己的路径", async () => {
  mount({
    task: task({ workspacePath: "C:\\nibi\\worktrees\\787b\\z-code" }),
    workspaceLabel: "   ",
  });
  const details = await openCard();
  expect(details.textContent).toContain("z-code");
  expect(details.textContent).toContain("C:\\nibi\\worktrees\\787b\\z-code");
});

it("打开后只查询一次 Git 快照，并显示分支与 +N/-N", async () => {
  fake.git.mockResolvedValue(gitSummary({ branchName: "feat/u26" }));
  mount({
    task: task({
      changeSummary: {
        fileCount: 2,
        added: 12,
        removed: 3,
        files: [{ path: "src/a.ts", added: 12, removed: 3, writeCount: 1, lastTurnIndex: 1 }],
      },
    }),
  });
  expect(fake.git).not.toHaveBeenCalled();

  const details = await openCard();
  await waitFor(() =>
    expect(details.querySelector('[data-task-row-branch="true"]')?.textContent).toContain(
      "feat/u26",
    ),
  );
  expect(details.textContent).toContain("+12");
  expect(details.textContent).toContain("-3");
  expect(fake.git).toHaveBeenCalledTimes(1);
  expect(fake.git).toHaveBeenCalledWith({ workspacePath: "/home/dev/project" });
});

it("HEAD 游离时显示游离 HEAD 文案", async () => {
  fake.git.mockResolvedValue(gitSummary({ headRefType: "detached", branchName: null }));
  mount();
  const details = await openCard();
  await waitFor(() =>
    expect(details.querySelector('[data-task-row-branch="true"]')?.textContent).toContain(
      "Detached HEAD",
    ),
  );
});

it("Git 查询失败时静默隐藏分支，卡片仍显示路径和活动", async () => {
  fake.git.mockRejectedValue(new Error("git unavailable"));
  mount();
  const details = await openCard();
  await waitFor(() => expect(fake.git).toHaveBeenCalledTimes(1));
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(details.querySelector('[data-task-row-branch="true"]')).toBeNull();
  expect(details.textContent).toContain("Last active");
  await waitFor(() => expect(details.textContent).toContain("~/project"));
});

it("触屏指针不打开，也不查询 Git", async () => {
  mount();
  fireEvent.pointerEnter(screen.getByText("task row"), { pointerType: "touch" });
  await waitForHoverDelay();
  expect(screen.queryByTestId("task-row-details")).toBeNull();
  expect(fake.git).not.toHaveBeenCalled();
});

it("粗指针环境不挂载卡片", async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: query.includes("pointer: coarse"),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(() => false),
    })),
  );
  try {
    mount();
    fireEvent.pointerEnter(screen.getByText("task row"), { pointerType: "mouse" });
    await waitForHoverDelay();
    expect(screen.queryByTestId("task-row-details")).toBeNull();
  } finally {
    vi.unstubAllGlobals();
    vi.stubGlobal("PointerEvent", TestPointerEvent);
  }
});

it("disabled（Web remote / 分组拖拽）时不打开", async () => {
  mount({ disabled: true });
  fireEvent.pointerEnter(screen.getByText("task row"), { pointerType: "mouse" });
  await waitForHoverDelay();
  expect(screen.queryByTestId("task-row-details")).toBeNull();
  expect(fake.git).not.toHaveBeenCalled();
});

it("远程未连接时显示设备徽标和原始路径，但不发 home/Git RPC", async () => {
  fake.remote = {
    services: fake.services,
    rpcReady: false,
    remoteSessionId: null,
    isRemoteTarget: true,
    connectionKind: "remote-waiting",
  };
  mount({
    task: task({
      workspacePath: "/srv/repo",
      workspaceIdentity: "remote:ssh:alpha.example.com:22:dev:/srv/repo",
      sourceServerId: "alpha",
      serverDisplayName: "Alpha",
    }),
    workspaceLabel: "repo",
  });

  const details = await openCard();
  expect(details.textContent).toContain("Alpha");
  expect(details.textContent).toContain("/srv/repo");
  expect(details.querySelector('[data-task-row-branch="true"]')).toBeNull();
  expect(fake.info).not.toHaveBeenCalled();
  expect(fake.git).not.toHaveBeenCalled();
});
