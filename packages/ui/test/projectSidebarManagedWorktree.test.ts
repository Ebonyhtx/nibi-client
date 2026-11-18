// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement, type ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectRowAction } from "@/project-sidebar/contract.js";
import { ProjectSidebarNode } from "@/project-sidebar/ProjectSidebarNode.js";

const probes = vi.hoisted(() => ({ node: vi.fn(), toast: vi.fn() }));
vi.mock("@/project-sidebar/ProjectNode.js", () => ({
  ProjectNode: (props: { additionalActions?: ProjectRowAction[] }) => {
    probes.node(props);
    return null;
  },
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: probes.toast }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useNibiIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/store/TabStoreProvider.js", () => ({ useTabStoreApi: () => ({}) }));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => async () => true }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function fixture(
  overrides: Partial<ComponentProps<typeof ProjectSidebarNode>["project"]> = {},
): ComponentProps<typeof ProjectSidebarNode> {
  return {
    project: {
      id: "p",
      hostId: "local",
      name: "Project",
      roots: [{ rootPath: "/repo/packages/app", position: 0, isPrimary: true }],
      pinned: false,
      deleted: false,
      position: 0,
      createdAt: 1,
      updatedAt: 1,
      nameOverridden: false,
      ...overrides,
    },
    tasks: [],
    expanded: true,
    onExpandedChange: vi.fn(),
    onEdit: vi.fn(),
    onViewFiles: vi.fn(async () => {}),
    onSelect: vi.fn(),
    onCreateTask: vi.fn(),
    onReconnectRemoteWorkspace: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}),
    remoteActions: () => [],
  };
}

function findWorktreeAction(props: {
  additionalActions?: ProjectRowAction[];
}): ProjectRowAction | undefined {
  return props.additionalActions?.find((action) => action.id === "create-worktree-task");
}

it("renders the worktree task action for local projects with a primary root", () => {
  render(createElement(ProjectSidebarNode, fixture()));
  const action = findWorktreeAction(probes.node.mock.lastCall![0]);
  expect(action).toMatchObject({
    id: "create-worktree-task",
    label: "project.newTaskInWorktree",
  });
});

it("creates a worktree task request with the source project id and root", () => {
  const props = fixture();
  render(createElement(ProjectSidebarNode, props));
  const action = findWorktreeAction(probes.node.mock.lastCall![0]);

  action!.run();

  expect(props.onCreateTask).toHaveBeenCalledWith(
    expect.objectContaining({
      projectId: "p",
      taskGroupId: null,
      managedWorktree: { sourceWorkspacePath: "/repo/packages/app" },
      onError: expect.any(Function),
    }),
  );

  const request = vi.mocked(props.onCreateTask).mock.calls[0]?.[0];
  request?.onError?.(new Error("managed-worktree.branch-exists"));
  expect(probes.toast).toHaveBeenCalledWith("Error: managed-worktree.branch-exists");
});

it("hides the worktree action for remote or legacy single-root projects", () => {
  const props = fixture({ hostId: "remote:server:example" });
  render(createElement(ProjectSidebarNode, props));
  expect(findWorktreeAction(probes.node.mock.lastCall![0])).toBeUndefined();

  cleanup();
  render(createElement(ProjectSidebarNode, fixture({ legacySingleRoot: true })));
  expect(findWorktreeAction(probes.node.mock.lastCall![0])).toBeUndefined();
});
