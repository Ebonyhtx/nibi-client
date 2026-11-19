// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement, type ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { ProjectRowAction } from "@/project-sidebar/contract.js";
import { ProjectSidebarNode } from "@/project-sidebar/ProjectSidebarNode.js";

const probes = vi.hoisted(() => ({ node: vi.fn() }));
vi.mock("@/project-sidebar/ProjectNode.js", () => ({
  ProjectNode: (props: { additionalActions?: ProjectRowAction[] }) => {
    probes.node(props);
    return null;
  },
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
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
    onOpenWorktrees: vi.fn(),
  };
}

function findWorktreeAction(props: {
  additionalActions?: ProjectRowAction[];
}): ProjectRowAction | undefined {
  return props.additionalActions?.find((action) => action.id === "worktrees");
}

it("renders the Worktrees menu for local projects when the base host provides the service", () => {
  render(createElement(ProjectSidebarNode, fixture()));
  const action = findWorktreeAction(probes.node.mock.lastCall![0]);
  expect(action).toMatchObject({ id: "worktrees", label: "project.worktrees" });
});

it("opens the Worktrees dialog for the project", () => {
  const props = fixture();
  render(createElement(ProjectSidebarNode, props));
  findWorktreeAction(probes.node.mock.lastCall![0])!.run();
  expect(props.onOpenWorktrees).toHaveBeenCalledWith(props.project);
});

it("hides the worktree entry without a local service, for remote or legacy single-root projects", () => {
  const withoutService = fixture();
  delete (withoutService as { onOpenWorktrees?: unknown }).onOpenWorktrees;
  render(createElement(ProjectSidebarNode, withoutService));
  expect(findWorktreeAction(probes.node.mock.lastCall![0])).toBeUndefined();

  cleanup();
  render(createElement(ProjectSidebarNode, fixture({ hostId: "remote:server:example" })));
  expect(findWorktreeAction(probes.node.mock.lastCall![0])).toBeUndefined();

  cleanup();
  render(createElement(ProjectSidebarNode, fixture({ legacySingleRoot: true })));
  expect(findWorktreeAction(probes.node.mock.lastCall![0])).toBeUndefined();
});