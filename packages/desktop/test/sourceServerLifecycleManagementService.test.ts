import { describe, expect, it, vi } from "vitest";
import { Emitter } from "@nibi/rpc";
import type { SourceServerConnectionStateSnapshot } from "@nibi/shared";
import { createSourceServerManagementService } from "../src/host/sourceServerManagementService.js";

const profileId = "17ef20b3-622d-4a53-98c1-0cdff29f3e6d";
const sourceServerId = "3cd4f9da-cd79-426c-9d70-75f36e9f6a87";
const target = { kind: "docker" as const, container: "nibi-dev" };
const profile = {
  profileId,
  sourceServerId,
  transport: "docker" as const,
  target,
  createdAt: 1,
};

function createService(input: {
  stopSource?: ReturnType<typeof vi.fn>;
  restartSource?: ReturnType<typeof vi.fn>;
  getSourceRunningTasks?: ReturnType<typeof vi.fn>;
  resolveSourceLifecycleRoute?: ReturnType<typeof vi.fn>;
}) {
  const states: SourceServerConnectionStateSnapshot[] = [];
  return createSourceServerManagementService({
    directory: {
      snapshot: vi.fn(async () => ({
        profiles: [profile],
        servers: [
          {
            sourceServerId,
            displayName: "device",
            preferredProfileId: profileId,
            installState: "installed" as const,
            declaredWorkspaces: [],
          },
        ],
        workspaceHistory: [],
      })),
      resolveSourceLifecycleRoute:
        input.resolveSourceLifecycleRoute ?? vi.fn(async () => ({ profile, target })),
    } as never,
    manager: {
      listStates: () => states,
      onDidChangeState: new Emitter<SourceServerConnectionStateSnapshot>().event,
      getOnlineConnection: () => undefined,
      stopSource: input.stopSource ?? vi.fn(async () => undefined),
      restartSource: input.restartSource ?? vi.fn(async () => ({})),
      getSourceRunningTasks:
        input.getSourceRunningTasks ?? vi.fn(async () => ({ available: false })),
    } as never,
    now: () => 10,
  });
}

describe("SourceServerManagementService remote service lifecycle", () => {
  it("routes stop and restart by device through the lifecycle route", async () => {
    const stopSource = vi.fn(async () => undefined);
    const restartSource = vi.fn(async () => ({}));
    const resolveSourceLifecycleRoute = vi.fn(async () => ({ profile, target }));
    const service = createService({ stopSource, restartSource, resolveSourceLifecycleRoute });
    try {
      const snapshot = await service.stopSource(sourceServerId);
      expect(snapshot.profiles).toHaveLength(1);
      expect(stopSource).toHaveBeenCalledWith({
        sourceServerId,
        resolveOfflineRoute: expect.any(Function),
      });
      await service.restartSource(sourceServerId);
      expect(restartSource).toHaveBeenCalledWith({
        sourceServerId,
        resolveOfflineRoute: expect.any(Function),
      });
      const route = await (
        stopSource.mock.calls[0]![0] as { resolveOfflineRoute: () => Promise<unknown> }
      ).resolveOfflineRoute();
      expect(route).toEqual({ profile, target });
      expect(resolveSourceLifecycleRoute).toHaveBeenCalledWith(sourceServerId);
    } finally {
      service.dispose();
    }
  });

  it("returns the running-task list and validates the lifecycle id", async () => {
    const getSourceRunningTasks = vi.fn(async () => ({
      available: true,
      tasks: [{ sessionId: "session-1", workspacePath: "/work/app" }],
    }));
    const service = createService({ getSourceRunningTasks });
    try {
      await expect(service.getSourceRunningTasks(sourceServerId)).resolves.toEqual({
        available: true,
        tasks: [{ sessionId: "session-1", workspacePath: "/work/app" }],
      });
      await expect(service.getSourceRunningTasks("not-a-device-id")).rejects.toThrow();
      expect(getSourceRunningTasks).toHaveBeenCalledOnce();
    } finally {
      service.dispose();
    }
  });
});
