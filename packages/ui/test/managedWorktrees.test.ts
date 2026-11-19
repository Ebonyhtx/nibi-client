// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  baseServices: {} as Record<string, unknown>,
  toast: vi.fn(),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => mocks.services,
  useOptionalServices: () => mocks.services,
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useOptionalBaseWorkspaceServices: () => mocks.baseServices,
  useBaseWorkspaceServices: () => mocks.baseServices,
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: mocks.toast }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useNibiIntl: () => ({
    intl: {
      formatMessage: (
        { id }: { id: string },
        values?: Record<string, string | number>,
      ): string => (values ? `${id}:${JSON.stringify(values)}` : id),
    },
  }),
}));
vi.mock("@/v4/ConversationUserInputBubble.js", () => ({
  ConversationUserInputBubble: ({ text }: { text: string }) =>
    createElement("div", { "data-testid": "user-bubble" }, text),
}));

import { ForkDestinationMenu } from "@/managed-worktrees/ForkDestinationMenu.js";
import { ManagedWorktreeCreationView } from "@/managed-worktrees/ManagedWorktreeCreationView.js";
import { formatManagedWorktreeError } from "@/managed-worktrees/managedWorktreeErrors.js";
import { useManagedWorktreeCreations } from "@/managed-worktrees/useManagedWorktreeCreations.js";
import { useTaskWorktreePlacement } from "@/managed-worktrees/useTaskWorktreePlacement.js";
import {
  resolveWorktreeSupport,
  useWorktreeSupport,
} from "@/managed-worktrees/useWorktreeSupport.js";
import { managedWorktreeRootFromPath } from "@/managed-worktrees/worktreeLabel.js";
import type { ManagedWorktreeCreation } from "@/managed-worktrees/contract.js";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.services = {};
  mocks.baseServices = {};
});

describe("useWorktreeSupport capability gate", () => {
  it("hides every entry when worktreeCwd is false", async () => {
    const getWorkspaceRepositoryInfo = vi.fn(async () => ({ kind: "repository" }));
    const supportsWorktreeCwd = vi.fn(async () => false);
    mocks.services = {
      gitService: { getWorkspaceRepositoryInfo },
      managedWorktreeService: { supportsWorktreeCwd },
    };
    const { result } = renderHook(() => useWorktreeSupport("/repo", undefined, true));
    await waitFor(() => expect(supportsWorktreeCwd).toHaveBeenCalledOnce());
    expect(result.current).toEqual({ visible: false, available: false });
  });

  it("hides when the project is not a Git repository", async () => {
    mocks.services = {
      gitService: {
        getWorkspaceRepositoryInfo: vi.fn(async () => ({ kind: "not-repository" })),
      },
      managedWorktreeService: { supportsWorktreeCwd: vi.fn(async () => true) },
    };
    const { result } = renderHook(() => useWorktreeSupport("/repo", undefined, true));
    await waitFor(() =>
      expect(result.current).toEqual({ visible: false, available: false }),
    );
  });

  it("shows the entry only when both the repository and capability are present", async () => {
    mocks.services = {
      gitService: {
        getWorkspaceRepositoryInfo: vi.fn(async () => ({ kind: "repository" })),
      },
      managedWorktreeService: { supportsWorktreeCwd: vi.fn(async () => true) },
    };
    const { result } = renderHook(() => useWorktreeSupport("/repo", undefined, true));
    await waitFor(() => expect(result.current).toEqual({ visible: true, available: true }));
  });

  it("does not query remote workspaces", () => {
    const getWorkspaceRepositoryInfo = vi.fn();
    mocks.services = {
      gitService: { getWorkspaceRepositoryInfo },
      managedWorktreeService: { supportsWorktreeCwd: vi.fn() },
    };
    const { result } = renderHook(() =>
      useWorktreeSupport("/repo", "remote:ssh:host:/repo", true),
    );
    expect(result.current).toEqual({ visible: false, available: false });
    expect(getWorkspaceRepositoryInfo).not.toHaveBeenCalled();
  });

  it("is a pure gate for callers that already know repository support", () => {
    expect(
      resolveWorktreeSupport({
        enabled: true,
        hasService: true,
        isRepository: true,
        supportsWorktreeCwd: false,
      }),
    ).toEqual({ visible: false, available: false });
    expect(
      resolveWorktreeSupport({
        enabled: true,
        hasService: true,
        isRepository: true,
        supportsWorktreeCwd: true,
      }),
    ).toEqual({ visible: true, available: true });
  });
});

describe("useManagedWorktreeCreations", () => {
  it("mirrors the Host list and follows pushed changes", async () => {
    let emit: ((next: ManagedWorktreeCreation[]) => void) | null = null;
    const dispose = vi.fn();
    const service = {
      onDidChangeCreations: vi.fn((handler: (next: ManagedWorktreeCreation[]) => void) => {
        emit = handler;
        return { dispose };
      }),
      listCreations: vi.fn(async () => []),
    };
    mocks.baseServices = { managedWorktreeService: service };
    const { result, unmount } = renderHook(() => useManagedWorktreeCreations());
    await waitFor(() => expect(service.listCreations).toHaveBeenCalledOnce());
    expect(result.current).toEqual([]);
    act(() => emit?.([{ id: "creation-1" } as ManagedWorktreeCreation]));
    expect(result.current.map((creation) => creation.id)).toEqual(["creation-1"]);
    unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("stays empty when the local host does not provide the service", () => {
    mocks.baseServices = {};
    const { result } = renderHook(() => useManagedWorktreeCreations());
    expect(result.current).toEqual([]);
  });
});

describe("useTaskWorktreePlacement", () => {
  it("reads cwd from tasks-index and marks a deleted managed worktree unavailable", async () => {
    const worktreeRoot = "C:\\data\\.nibi\\worktrees\\ab12\\repo";
    const resolveSessionDirectories = vi.fn(async () => ({
      workspacePath: `${worktreeRoot}\\packages\\ui`,
      additionalDirectories: [],
      projectId: "project-1",
    }));
    const isWorktreeAvailable = vi.fn(async () => true);
    let onBroadcast: ((event: { channel: string }) => void) | null = null;
    const onMessage = vi.fn((handler: (event: { channel: string }) => void) => {
      onBroadcast = handler;
      return { dispose: vi.fn() };
    });
    mocks.services = {
      projectService: { resolveSessionDirectories },
      managedWorktreeService: { isWorktreeAvailable },
    };
    mocks.baseServices = { broadcastService: { onMessage } };

    const { result } = renderHook(() =>
      useTaskWorktreePlacement({
        workspacePath: "C:\\repo",
        sessionId: "task-1",
      }),
    );
    await waitFor(() => expect(result.current.worktreeRoot).toBe(worktreeRoot));
    expect(result.current.cwd).toBe(`${worktreeRoot}\\packages\\ui`);
    expect(result.current.worktreeAvailable).toBe(true);

    isWorktreeAvailable.mockResolvedValueOnce(false);
    act(() => onBroadcast?.({ channel: "state:projects" }));
    await waitFor(() => expect(result.current.worktreeAvailable).toBe(false));
  });

  it("keeps ordinary tasks on the workspace cwd without probing worktree availability", async () => {
    const isWorktreeAvailable = vi.fn();
    mocks.services = {
      projectService: {
        resolveSessionDirectories: vi.fn(async () => ({
          workspacePath: "/repo",
          additionalDirectories: [],
          projectId: "project-1",
        })),
      },
      managedWorktreeService: { isWorktreeAvailable },
    };
    mocks.baseServices = { broadcastService: { onMessage: vi.fn(() => ({ dispose: vi.fn() })) } };
    const { result } = renderHook(() =>
      useTaskWorktreePlacement({ workspacePath: "/repo", sessionId: "task-1" }),
    );
    await waitFor(() => expect(result.current.cwd).toBe("/repo"));
    expect(result.current.worktreeRoot).toBeUndefined();
    expect(result.current.worktreeAvailable).toBe(true);
    expect(isWorktreeAvailable).not.toHaveBeenCalled();
  });

  it("recognizes the managed layout and keeps missing directories read-only", () => {
    expect(managedWorktreeRootFromPath("/data/.nibi/worktrees/ab12/repo/sub")).toBe(
      "/data/.nibi/worktrees/ab12/repo",
    );
    expect(managedWorktreeRootFromPath("C:\\data\\.nibi\\worktrees\\ab12\\repo")).toBe(
      "C:\\data\\.nibi\\worktrees\\ab12\\repo",
    );
    expect(managedWorktreeRootFromPath("/repo/packages/ui")).toBeNull();
  });
});

describe("ForkDestinationMenu", () => {
  it("runs both fork destinations", () => {
    const onForkHere = vi.fn();
    const onForkToWorktree = vi.fn();
    render(
      createElement(ForkDestinationMenu, {
        rowId: 7,
        label: "Fork",
        worktreeAvailable: true,
        inWorktree: false,
        onForkHere,
        onForkToWorktree,
      }),
    );
    fireEvent.pointerDown(screen.getByTestId("v4-fork-7"), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByTestId("worktree-fork-here-7"));
    expect(onForkHere).toHaveBeenCalledOnce();
    fireEvent.pointerDown(screen.getByTestId("v4-fork-7"), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByTestId("worktree-fork-to-worktree-7"));
    expect(onForkToWorktree).toHaveBeenCalledOnce();
  });
});

describe("ManagedWorktreeCreationView error path", () => {
  const failedCreation: ManagedWorktreeCreation = {
    id: "creation-1",
    kind: "new-task",
    projectId: "project-1",
    workspacePath: "/repo",
    phase: "failed",
    ref: null,
    worktreePath: "/data/.nibi/worktrees/ab12/repo",
    output: "fatal: worktree add failed",
    error: { code: "git-failed", detail: "exit 128" },
    promptText: "hello",
    parentSessionId: null,
    createdAt: 1,
  };

  it("keeps the worktree record and reports a failed retry", async () => {
    const retryCreation = vi.fn(async () => {
      throw new Error("worktree.removing");
    });
    const dismissCreation = vi.fn(async () => {});
    mocks.baseServices = {
      managedWorktreeService: { retryCreation, dismissCreation },
    };
    render(createElement(ManagedWorktreeCreationView, { creation: failedCreation }));
    expect(screen.getByTestId("worktree-creation-card").getAttribute("data-phase")).toBe(
      "failed",
    );
    expect(screen.getByText("git.managedWorktree.error.git-failed")).toBeTruthy();
    fireEvent.click(screen.getByTestId("worktree-creation-retry"));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("git.managedWorktree.error.removing"));
    expect(screen.getByTestId("worktree-creation-card").getAttribute("data-phase")).toBe(
      "failed",
    );
    expect(dismissCreation).not.toHaveBeenCalled();
  });

  it("formats structured and thrown errors by code", () => {
    const intl = {
      formatMessage: ({ id }: { id: string }) => id,
    };
    expect(formatManagedWorktreeError(intl, "worktree.git-failed")).toBe(
      "git.managedWorktree.error.git-failed",
    );
    expect(formatManagedWorktreeError(intl, new Error("unknown"))).toBe(
      "git.managedWorktree.error.generic",
    );
  });
});