// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useProjectRemoteSync } from "@/project-sidebar/useProjectRemoteSync.js";

const mocks = vi.hoisted(() => ({
  sessions: {} as Record<string, unknown>,
  openDataSync: vi.fn(),
}));

vi.mock("@/store/remoteWorkspaceSessionStore.js", () => ({
  useRemoteWorkspaceSessionStore: (select: (value: unknown) => unknown) =>
    select({ sessionsById: mocks.sessions }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({ skillSyncService: {} }),
}));
vi.mock("@/hooks/useOpenDataSyncSettings.js", () => ({
  useOpenDataSyncSettings: () => mocks.openDataSync,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

beforeEach(() => {
  mocks.openDataSync.mockClear();
});

it("routes project sync actions to the unified data sync page and drops disconnected roots", () => {
  const host = {
    id: "remote:server:s",
    membershipId: "m",
    kind: "ssh",
    target: { kind: "ssh", host: "example", username: "user" },
    connectionStatus: "online",
  };
  const project = {
    id: "p",
    hostId: host.id,
    name: "p",
    roots: [{ rootPath: "/repo", position: 0, isPrimary: true }],
  };
  mocks.sessions = {
    s: { sessionId: "s", workspaceIdentity: "remote:server:s:/repo", workspacePath: "/repo" },
  };
  const { result, rerender } = renderHook(
    ({ mobile, online }) =>
      useProjectRemoteSync(
        { isWebRemoteControl: mobile } as never,
        {
          hosts: [{ ...host, connectionStatus: online ? "online" : "offline" }],
          entries: [],
        } as never,
      ),
    { initialProps: { mobile: false, online: true } },
  );

  const actions = result.current.actions(project as never);
  expect(actions.map((action) => action.id)).toEqual([
    "sync-skills-0",
    "sync-mcp-0",
    "sync-plugins-0",
  ]);

  act(() => actions[0]!.run());
  act(() => actions[1]!.run());
  act(() => actions[2]!.run());
  expect(mocks.openDataSync.mock.calls).toEqual([["skills"], ["mcp"], ["plugins"]]);

  rerender({ mobile: false, online: false });
  expect(result.current.actions(project as never)).toEqual([]);
  rerender({ mobile: false, online: true });
  mocks.sessions = {};
  rerender({ mobile: false, online: true });
  expect(result.current.actions(project as never)).toEqual([]);
  mocks.sessions = {
    s: { sessionId: "s", workspaceIdentity: "remote:server:s:/repo", workspacePath: "/repo" },
  };
  rerender({ mobile: true, online: true });
  expect(result.current.actions(project as never)).toEqual([]);
});
