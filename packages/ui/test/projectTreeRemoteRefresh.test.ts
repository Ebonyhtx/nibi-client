import { describe, expect, it, vi } from "vitest";
import { readProjectSidebarTree } from "@/project-sidebar/project-tree-reader.js";
import type {
  IProjectService,
  IRemoteProjectService,
  RemoteProjectDirectory,
  ProjectTree,
} from "@/project-sidebar/contract.js";

function fixture() {
  let directory: RemoteProjectDirectory = {
    hosts: [
      {
        id: "remote:server:s",
        membershipId: "m",
        kind: "docker",
        target: { kind: "docker", container: "s" },
        position: 1,
        connectionStatus: "online",
      },
    ],
    entries: [
      {
        id: "entry",
        hostId: "remote:server:s",
        projectId: "p",
        name: "cached",
        roots: [],
        lastSyncedAt: 1,
        legacyWorkspace: null,
      },
    ],
  };
  const remote: ProjectTree = {
    tasks: [],
    projects: [
      {
        id: "p",
        hostId: "remote:server:s",
        name: "remote",
        roots: [],
        deleted: false,
        pinned: false,
        nameOverridden: false,
        position: 1,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  };
  const readTree = vi.fn(async (input?: { hostId?: string }) =>
    input?.hostId ? remote : { projects: [], tasks: [] },
  );
  const refreshEntry = vi.fn(async () => true);
  return {
    remote,
    readTree,
    refreshEntry,
    setDirectory: (next: RemoteProjectDirectory) => {
      directory = next;
    },
    read: () =>
      readProjectSidebarTree({
        projectService: { readTree } as unknown as IProjectService,
        remoteProjectService: {
          readDirectory: async () => directory,
          refreshEntry,
        } as unknown as IRemoteProjectService,
      }),
  };
}
describe("project tree remote refresh", () => {
  it("reads the existing owner, then refreshes only retained entry IDs with their original version", async () => {
    const { read, readTree, refreshEntry } = fixture();
    const result = await read();
    expect(readTree).toHaveBeenCalledWith({
      hostId: "remote:server:s",
      includeDeleted: true,
      includeDeletedTasks: true,
    });
    expect(refreshEntry).toHaveBeenCalledWith({
      entryId: "entry",
      expectedLastSyncedAt: 1,
      project: { projectId: "p", name: "remote", roots: [] },
    });
    expect(result.tree.projects[0]?.id).toBe("p");
  });
  it("keeps offline project cache without discarding the local tree", async () => {
    const { read, readTree, refreshEntry } = fixture();
    readTree.mockImplementation(async (input) => {
      if (input?.hostId) throw new Error("offline");
      return { projects: [], tasks: [] };
    });
    const result = await read();
    expect(result.tree.projects[0]?.name).toBe("cached");
    expect(refreshEntry).not.toHaveBeenCalled();
  });
  it("离线主机不发起 readTree，也不产生连接失败记录，入口缓存仍显示", async () => {
    const { read, readTree, refreshEntry, setDirectory } = fixture();
    setDirectory({
      hosts: [
        {
          id: "remote:server:s",
          membershipId: "m",
          kind: "docker",
          target: { kind: "docker", container: "s" },
          position: 1,
          connectionStatus: "offline",
        },
      ],
      entries: [
        {
          id: "entry",
          hostId: "remote:server:s",
          projectId: "p",
          name: "cached",
          roots: [],
          lastSyncedAt: 1,
          legacyWorkspace: null,
        },
      ],
    });
    const result = await read();
    expect(readTree).toHaveBeenCalledTimes(1);
    expect(readTree).toHaveBeenCalledWith({ includeDeleted: true, includeDeletedTasks: true });
    expect(result.errors.size).toBe(0);
    expect(result.tree.projects[0]?.name).toBe("cached");
    expect(refreshEntry).not.toHaveBeenCalled();
  });
  it("读取开始后断线仍按失败记录", async () => {
    const { read, readTree } = fixture();
    readTree.mockImplementation(async (input) => {
      if (input?.hostId) throw new Error("project.host-offline");
      return { projects: [], tasks: [] };
    });
    const result = await read();
    expect(result.errors.get("remote:server:s")).toContain("project.host-offline");
  });
  it("rejects a completed read from a removed or replaced host membership", async () => {
    const { read, readTree, setDirectory, remote } = fixture();
    readTree.mockImplementation(async (input) => {
      if (input?.hostId) {
        setDirectory({ hosts: [], entries: [] });
        return remote;
      }
      return { projects: [], tasks: [] };
    });
    expect((await read()).tree).toEqual({ projects: [], tasks: [] });
  });
});
