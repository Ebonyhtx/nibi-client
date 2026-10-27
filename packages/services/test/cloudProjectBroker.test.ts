import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOUD_PROJECT_BROKER_TOKEN_ENV,
  CLOUD_PROJECT_BROKER_URL_ENV,
  createCloudProjectBroker,
  type CloudProjectBroker,
} from "../src/cloud-project/cloudProjectBroker.js";
import type {
  IProjectSyncService,
  ProjectSummary,
} from "../src/project-sync/projectSyncClient.js";

function fakeProjectSync() {
  const project: ProjectSummary = { id: "p1", name: "数模 A", role: "owner", headVersion: 1 };
  return {
    createProject: vi.fn(async (name: string) => ({ project: { ...project, name }, inviteCode: "inv-1" })),
    joinProject: vi.fn(async () => ({ ...project, role: "editor" as const })),
    listProjects: vi.fn(async () => [project]),
    projectStatus: vi.fn(async () => ({ project, headVersion: 1, members: [] })),
    getVersion: vi.fn(async (_id: string, revision: number) => ({ revision, files: {}, deleted: [] })),
    upload: vi.fn(async () => ({ kind: "committed" as const, revision: 2, uploadedObjects: 1, reusedObjects: 0 })),
    pull: vi.fn(async () => ({ revision: 1, written: 1, removed: 0, backupDir: null })),
    resolveConflicts: vi.fn(async () => ({
      kind: "merge" as const,
      revision: 3,
      resolved: 1,
      conflictsRemaining: [],
      pulled: true,
    })),
  } satisfies IProjectSyncService;
}

let broker: CloudProjectBroker | null = null;

afterEach(async () => {
  await broker?.dispose();
  broker = null;
});

async function post(
  url: string,
  token: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}/v1/project-sync`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("cloudProjectBroker", () => {
  it("只接受带工作区能力令牌的调用", async () => {
    const projectSync = fakeProjectSync();
    broker = createCloudProjectBroker({ projectSync });
    const env = await broker.envForWorkspace("/tmp/nibi-cloud-ws");
    const url = env[CLOUD_PROJECT_BROKER_URL_ENV]!;
    const token = env[CLOUD_PROJECT_BROKER_TOKEN_ENV]!;

    expect((await post(url, "wrong-token", { action: "list" })).status).toBe(401);
    const listed = await post(url, token, { action: "list" });
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ ok: true, result: [{ id: "p1" }] });
    expect(projectSync.listProjects).toHaveBeenCalledTimes(1);
  });

  it("upload/pull 使用令牌绑定的工作区，并拒绝伪造 workspace", async () => {
    const projectSync = fakeProjectSync();
    broker = createCloudProjectBroker({ projectSync });
    const workspace = process.platform === "win32" ? "C:\\tmp\\nibi-cloud-ws" : "/tmp/nibi-cloud-ws";
    const env = await broker.envForWorkspace(workspace);
    const url = env[CLOUD_PROJECT_BROKER_URL_ENV]!;
    const token = env[CLOUD_PROJECT_BROKER_TOKEN_ENV]!;

    const mismatch = await post(url, token, {
      action: "upload",
      projectId: "p1",
      workspace: process.platform === "win32" ? "C:\\other" : "/tmp/other",
    });
    expect(mismatch.status).toBe(403);

    const uploaded = await post(url, token, {
      action: "upload",
      projectId: "p1",
      message: "第 2 轮",
      workspace,
    });
    expect(uploaded.status).toBe(200);
    expect(uploaded.body).toMatchObject({ ok: true, result: { kind: "committed", revision: 2 } });
    expect(projectSync.upload).toHaveBeenCalledWith(workspace, "p1", "第 2 轮");

    await post(url, token, { action: "pull", projectId: "p1" });
    expect(projectSync.pull).toHaveBeenCalledWith(workspace, "p1");
  });

  it("参数校验与领域错误分开：400 / ok:false", async () => {
    const projectSync = fakeProjectSync();
    broker = createCloudProjectBroker({ projectSync });
    const env = await broker.envForWorkspace("/tmp/nibi-cloud-ws");
    const url = env[CLOUD_PROJECT_BROKER_URL_ENV]!;
    const token = env[CLOUD_PROJECT_BROKER_TOKEN_ENV]!;

    expect((await post(url, token, { action: "create", name: "  " })).status).toBe(400);
    const unknown = await post(url, token, { action: "nope" });
    expect(unknown.status).toBe(400);

    projectSync.createProject.mockRejectedValueOnce(new Error("需要有效的 NIBI 会员才能创建项目或上传版本"));
    const rejected = await post(url, token, { action: "create", name: "数模 A" });
    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({
      ok: false,
      error: { code: "project_sync_failed", message: "需要有效的 NIBI 会员才能创建项目或上传版本" },
    });
  });

  it("令牌过期后拒绝", async () => {
    const projectSync = fakeProjectSync();
    broker = createCloudProjectBroker({ projectSync, tokenTtlMs: 5 });
    const env = await broker.envForWorkspace("/tmp/nibi-cloud-ws");
    const url = env[CLOUD_PROJECT_BROKER_URL_ENV]!;
    const token = env[CLOUD_PROJECT_BROKER_TOKEN_ENV]!;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    expect((await post(url, token, { action: "list" })).status).toBe(401);
  });
});
