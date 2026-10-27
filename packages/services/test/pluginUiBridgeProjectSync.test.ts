import { describe, expect, it, vi } from "vitest";
import type {
  IProjectSyncService,
  ProjectSummary,
  PullResult,
  ResolveConflictResult,
  UploadResult,
  VersionFileSet,
} from "../src/project-sync/projectSyncClient.js";
import { createPluginUiBridgeService, PluginUiBridgeError } from "../src/plugin-ui-bridge/pluginUiBridgeService.js";

const project: ProjectSummary = { id: "p1", name: "数模 A", role: "owner", headVersion: 3 };
const uploadResult: UploadResult = {
  kind: "committed",
  revision: 4,
  uploadedObjects: 2,
  reusedObjects: 1,
};
const pullResult: PullResult = { revision: 4, written: 2, removed: 0, backupDir: null };
const version: VersionFileSet = { revision: 4, files: { "a.tex": "ha" }, deleted: [] };
const resolveResult: ResolveConflictResult = {
  kind: "merge",
  revision: 5,
  resolved: 1,
  conflictsRemaining: [],
  pulled: true,
};

const scope = {
  workspacePath: "D:/workspace",
  workspaceIdentity: "ws-1",
  sessionId: "session-1",
  pluginId: "math-modeling",
  serverName: "plugin:math-modeling:main",
  instance: {
    runtimeId: "agent-1",
    generation: 1,
    token: "instance-token",
    appIdentity: "a".repeat(64),
  },
};

function fakeClient(overrides: Partial<IProjectSyncService> = {}): IProjectSyncService {
  return {
    createProject: vi.fn(async () => ({ project, inviteCode: "JOIN-1" })),
    joinProject: vi.fn(async () => project),
    listProjects: vi.fn(async () => [project]),
    projectStatus: vi.fn(async () => ({ project, headVersion: 4, members: [] })),
    getVersion: vi.fn(async () => version),
    upload: vi.fn(async () => uploadResult),
    pull: vi.fn(async () => pullResult),
    resolveConflicts: vi.fn(async () => resolveResult),
    ...overrides,
  };
}

function bridgeWith(client: IProjectSyncService) {
  return createPluginUiBridgeService({
    projectSync: client,
    validateInstance: async () => undefined,
  });
}

describe("面板云端项目受限通道", () => {
  it("没有宿主同步依赖时明确不可用", async () => {
    const service = createPluginUiBridgeService();
    await expect(service.projectSync({ ...scope, request: { action: "list" } })).rejects.toMatchObject(
      { code: "unavailable" },
    );
  });

  it("没有实例校验能力时同样不可用（不退化成任意页面可调）", async () => {
    const service = createPluginUiBridgeService({ projectSync: fakeClient() });
    await expect(service.projectSync({ ...scope, request: { action: "list" } })).rejects.toMatchObject(
      { code: "unavailable" },
    );
  });

  it("请求形状不对时在宿主侧拒绝", async () => {
    const service = bridgeWith(fakeClient());
    const malformed = { ...scope, request: undefined } as unknown as Parameters<
      typeof service.projectSync
    >[0];
    await expect(service.projectSync(malformed)).rejects.toMatchObject({ code: "invalid_params" });
  });

  it("调用前先校验面板实例归属", async () => {
    const validateInstance = vi.fn(async () => undefined);
    const service = createPluginUiBridgeService({
      projectSync: fakeClient(),
      validateInstance,
    });
    await service.projectSync({ ...scope, request: { action: "list" } });
    expect(validateInstance).toHaveBeenCalledOnce();
  });

  it("list / create / join / status / version 按动作分发", async () => {
    const client = fakeClient();
    const service = bridgeWith(client);

    await expect(service.projectSync({ ...scope, request: { action: "list" } })).resolves.toEqual({
      kind: "projects",
      projects: [project],
    });
    await expect(
      service.projectSync({ ...scope, request: { action: "create", name: "  数模 A " } }),
    ).resolves.toEqual({ kind: "project", project, inviteCode: "JOIN-1" });
    expect(client.createProject).toHaveBeenCalledWith("数模 A");

    await service.projectSync({ ...scope, request: { action: "join", inviteCode: " JOIN-1 " } });
    expect(client.joinProject).toHaveBeenCalledWith("JOIN-1");

    await expect(
      service.projectSync({ ...scope, request: { action: "status", projectId: "p1" } }),
    ).resolves.toEqual({ kind: "status", project, headVersion: 4, members: [] });
    await service.projectSync({
      ...scope,
      request: { action: "version", projectId: "p1", revision: 4 },
    });
    expect(client.getVersion).toHaveBeenCalledWith("p1", 4);
  });

  it("成员列表去掉邮箱，只给面板角色与显示名", async () => {
    const client = fakeClient({
      projectStatus: vi.fn(async () => ({
        project,
        headVersion: 4,
        members: [
          { role: "owner", displayName: "我", email: "me@example.com" },
          { role: "editor", displayName: "队友", email: "teammate@example.com" },
        ],
      })),
    });
    const service = bridgeWith(client);
    await expect(
      service.projectSync({ ...scope, request: { action: "status", projectId: "p1" } }),
    ).resolves.toEqual({
      kind: "status",
      project,
      headVersion: 4,
      members: [
        { role: "owner", displayName: "我" },
        { role: "editor", displayName: "队友" },
      ],
    });
  });

  it("upload / pull 只使用宿主登记的 workspace，忽略页面夹带的路径", async () => {
    const client = fakeClient();
    const service = bridgeWith(client);
    const tampered = {
      ...scope,
      workspacePath: "D:/workspace",
      request: {
        action: "upload" as const,
        projectId: "p1",
        message: "  初稿  ",
        workspacePath: "D:/elsewhere",
      },
    };

    await expect(
      service.projectSync(tampered as Parameters<typeof service.projectSync>[0]),
    ).resolves.toEqual({ kind: "upload", result: uploadResult });
    expect(client.upload).toHaveBeenCalledWith("D:/workspace", "p1", "初稿");

    await service.projectSync({ ...scope, request: { action: "pull", projectId: "p1" } });
    expect(client.pull).toHaveBeenCalledWith("D:/workspace", "p1");
  });

  it("resolve 使用宿主 workspace 并透传逐文件选择", async () => {
    const client = fakeClient();
    const service = bridgeWith(client);
    await expect(
      service.projectSync({
        ...scope,
        request: {
          action: "resolve",
          projectId: "p1",
          revision: 5,
          choices: { "a.tex": "theirs" },
        },
      }),
    ).resolves.toEqual({ kind: "resolve", result: resolveResult });
    expect(client.resolveConflicts).toHaveBeenCalledWith("D:/workspace", "p1", 5, {
      "a.tex": "theirs",
    });

    const invalid = await service
      .projectSync({
        ...scope,
        request: {
          action: "resolve",
          projectId: "p1",
          revision: 5,
          choices: { "a.tex": "mine" as never },
        },
      })
      .catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(PluginUiBridgeError);
    expect((invalid as PluginUiBridgeError).code).toBe("invalid_params");
  });

  it("参数不合法时在宿主侧拒绝，不触达服务端", async () => {
    const client = fakeClient();
    const service = bridgeWith(client);
    const failure = await service
      .projectSync({ ...scope, request: { action: "status", projectId: "  " } })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PluginUiBridgeError);
    expect((failure as PluginUiBridgeError).code).toBe("invalid_params");
    expect(client.projectStatus).not.toHaveBeenCalled();

    await expect(
      service.projectSync({ ...scope, request: { action: "version", projectId: "p1", revision: 0 } }),
    ).rejects.toMatchObject({ code: "invalid_params" });
  });
});
