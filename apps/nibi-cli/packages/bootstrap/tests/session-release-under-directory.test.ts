// session/releaseUnderDirectory：CLI 是驻留会话及其忙闲的唯一判定者。
// Host 删除受管 worktree 前用它卸载 cwd 位于 worktree 内的全部驻留会话：任一会话忙时全部不卸载；
// 关闭失败必须让请求失败，不能返回空结果假装成功。
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { nibiProtocolMethods, type NibiProtocolMessage } from "@nibi/shared";
import { NibiProtocolAgentServer } from "../src/nibi-protocol/server.js";
import { createFakeApp } from "./helpers/fake-nibi-app.js";

const PROJECT = join("fixture", "repo");
const WORKTREE = join("fixture", "worktrees", "3f2a", "repo");

async function request(server: NibiProtocolAgentServer, method: string, params: unknown) {
  const response = await server.handleMessage({ id: 1, method, params } as NibiProtocolMessage);
  if (!response || !("result" in response)) throw new Error(JSON.stringify(response));
  return response.result;
}

/** 两个会话：一个 cwd 在 worktree 子目录中，一个在项目主目录中。 */
async function boot() {
  const apps: Array<ReturnType<typeof createFakeApp>> = [];
  const server = new NibiProtocolAgentServer({
    createNibiApp: (options) => {
      const app = createFakeApp(options);
      apps.push(app);
      return app;
    },
  });
  await request(server, nibiProtocolMethods.sessionCreate, {
    workspace: { workspacePath: join(WORKTREE, "packages", "ui"), workspaceKey: PROJECT },
  });
  await request(server, nibiProtocolMethods.sessionCreate, {
    workspace: { workspacePath: PROJECT, workspaceKey: PROJECT },
  });
  const [inWorktree, inProject] = apps as [
    ReturnType<typeof createFakeApp>,
    ReturnType<typeof createFakeApp>,
  ];
  return { server, inWorktree, inProject };
}

describe("session/releaseUnderDirectory", () => {
  it("只卸载 cwd 位于目录内的空闲会话", async () => {
    const { server, inWorktree, inProject } = await boot();
    const closeWorktree = vi.spyOn(inWorktree, "close");
    const closeProject = vi.spyOn(inProject, "close");
    expect(
      await request(server, nibiProtocolMethods.sessionReleaseUnderDirectory, {
        directory: WORKTREE,
      }),
    ).toEqual({ released: [inWorktree.sessionId], busy: [] });
    expect(closeWorktree).toHaveBeenCalledTimes(1);
    expect(closeProject).not.toHaveBeenCalled();
  });

  it("任一会话忙时全部不卸载，返回忙的会话", async () => {
    const { server, inWorktree } = await boot();
    const close = vi.spyOn(inWorktree, "close");
    vi.spyOn(inWorktree.runtime, "hasResidencyBlockingWork").mockReturnValue(true);
    expect(
      await request(server, nibiProtocolMethods.sessionReleaseUnderDirectory, {
        directory: WORKTREE,
      }),
    ).toEqual({ released: [], busy: [inWorktree.sessionId] });
    expect(close).not.toHaveBeenCalled();
  });

  it("目录内没有驻留会话时返回空结果", async () => {
    const { server } = await boot();
    expect(
      await request(server, nibiProtocolMethods.sessionReleaseUnderDirectory, {
        directory: join("fixture", "worktrees", "9999", "repo"),
      }),
    ).toEqual({ released: [], busy: [] });
  });

  it("关闭失败返回错误，不伪装成卸载成功", async () => {
    const { server, inWorktree } = await boot();
    vi.spyOn(inWorktree, "close").mockRejectedValue(new Error("runtime close failed"));
    const response = await server.handleMessage({
      id: 1,
      method: nibiProtocolMethods.sessionReleaseUnderDirectory,
      params: { directory: WORKTREE },
    } as NibiProtocolMessage);
    expect(response && "error" in response).toBe(true);
    expect(JSON.stringify(response)).toContain("runtime close failed");
  });

  it("句柄参数不合法时拒绝（strict schema）", async () => {
    const { server } = await boot();
    const response = await server.handleMessage({
      id: 1,
      method: nibiProtocolMethods.sessionReleaseUnderDirectory,
      params: { directory: WORKTREE, sessionId: "s1" },
    } as NibiProtocolMessage);
    expect(response && "error" in response).toBe(true);
  });
});
