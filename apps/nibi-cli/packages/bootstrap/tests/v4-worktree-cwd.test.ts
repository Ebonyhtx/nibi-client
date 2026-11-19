// 受管 worktree 的会话 cwd（agent-protocol 扩展）：runtime/capabilities.worktreeCwd、
// createSession.cwd/worktreeCreation、forkAssistant.targetCwd。
// 语义：只接受 Host 可信路径；目录必须存在且在 worktree 根内；失败显式拒绝且不留半会话。
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { nibiProtocolMethods, type NibiProtocolMessage } from "@nibi/shared";
import type { CommandEnvelope } from "@nibi/shared/nibi-protocol-v4";
import { V4CommandExecutor } from "../src/nibi-protocol-v4/commands/executor.js";
import { V4InputAdmissionRejectedError } from "../src/nibi-protocol-v4/commands/input-admission.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/nibi-protocol-v4/commands/types.js";
import { resolveTrustedSessionWorkspace } from "../src/nibi-protocol/v4-bridge.js";
import {
  buildWorkspaceRef,
  resolveResumeWorkspaceRef,
} from "../src/nibi-protocol/workspace.js";
import { NibiProtocolAgentServer } from "../src/nibi-protocol/server.js";
import { createFakeApp } from "./helpers/fake-nibi-app.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nibi-worktree-cwd-"));
  const project = join(root, "project");
  const worktree = join(root, "worktrees", "3f2a", "project");
  const cwd = join(worktree, "packages", "ui");
  const outside = join(root, "outside");
  await Promise.all([
    mkdir(project, { recursive: true }),
    mkdir(cwd, { recursive: true }),
    mkdir(outside, { recursive: true }),
  ]);
  const file = join(root, "not-a-directory");
  await writeFile(file, "x");
  const worktreeCreation = { path: worktree, sha: "abc", ref: null, output: "" };
  return { root, project, worktree, cwd, outside, file, worktreeCreation };
}

function envelope(type: string, payload: unknown): CommandEnvelope {
  return {
    type,
    payload,
    sessionId: type === "createSession" ? null : "s1",
    commandId: "cmd-1",
    clientId: "host",
    baseRevision: 0,
  } as unknown as CommandEnvelope;
}

const recordPendingWorktreeCreation = vi.fn();

function makeRecord(): V4SessionRecordView {
  return {
    app: {
      sessionId: "s1",
      runtime: { recordPendingWorktreeCreation },
    } as unknown as V4SessionRecordView["app"],
    traceContext: { traceId: "trace-1", sessionId: "s1" } as never,
    workspace: { workspacePath: "/w" },
    persistence: "immediate",
  } as V4SessionRecordView;
}

function makeHost(overrides: Partial<V4CommandCoreHost> = {}): V4CommandCoreHost {
  return {
    getRecord: () => makeRecord(),
    waitForProjectionEventCommit: async () => {},
    ...overrides,
  };
}

describe("runtime/capabilities.worktreeCwd", () => {
  it("内核支持 Host 受管 cwd 时声明 true", async () => {
    const server = new NibiProtocolAgentServer({
      createNibiApp: (options) => createFakeApp(options),
    });
    const response = await server.handleMessage({
      id: 1,
      method: nibiProtocolMethods.runtimeCapabilities,
      params: null,
    } as NibiProtocolMessage);
    expect(response && "result" in response).toBe(true);
    expect(response && "result" in response ? response.result : null).toMatchObject({
      worktreeCwd: true,
    });
  });
});

describe("resolveTrustedSessionWorkspace", () => {
  it("cwd 在 worktree 根内：workspace key 不变，执行路径换成 cwd", async () => {
    const f = await fixture();
    const workspace = buildWorkspaceRef({ workspacePath: f.project });
    await expect(
      resolveTrustedSessionWorkspace(workspace, f.cwd, f.worktreeCreation),
    ).resolves.toEqual({ workspaceKey: f.project, workspacePath: f.cwd });
  });

  it("cwd 与 workspace 相同：保持原 workspace（无覆盖）", async () => {
    const f = await fixture();
    const workspace = buildWorkspaceRef({ workspacePath: f.project });
    await expect(resolveTrustedSessionWorkspace(workspace, f.project, undefined)).resolves.toBe(
      workspace,
    );
  });

  it("目录不存在：显式拒绝", async () => {
    const f = await fixture();
    await expect(
      resolveTrustedSessionWorkspace(
        buildWorkspaceRef({ workspacePath: f.project }),
        join(f.worktree, "missing"),
        f.worktreeCreation,
      ),
    ).rejects.toThrow(/guard\.worktreeCwdUnavailable/);
  });

  it("路径不是目录：显式拒绝", async () => {
    const f = await fixture();
    await expect(
      resolveTrustedSessionWorkspace(
        buildWorkspaceRef({ workspacePath: f.project }),
        f.file,
        { ...f.worktreeCreation, path: f.root },
      ),
    ).rejects.toThrow(/guard\.worktreeCwdUnavailable/);
  });

  it("相对路径：显式拒绝（Host 只能下发绝对路径）", async () => {
    const f = await fixture();
    await expect(
      resolveTrustedSessionWorkspace(
        buildWorkspaceRef({ workspacePath: f.project }),
        "relative/path",
        f.worktreeCreation,
      ),
    ).rejects.toThrow(/guard\.worktreeCwdUnavailable/);
  });

  it("cwd 不同但缺 worktreeCreation：拒绝伪造", async () => {
    const f = await fixture();
    await expect(
      resolveTrustedSessionWorkspace(buildWorkspaceRef({ workspacePath: f.project }), f.cwd, undefined),
    ).rejects.toThrow(/guard\.worktreeCwdUntrusted/);
  });

  it("cwd 越出 worktree 根：拒绝", async () => {
    const f = await fixture();
    await expect(
      resolveTrustedSessionWorkspace(
        buildWorkspaceRef({ workspacePath: f.project }),
        f.outside,
        f.worktreeCreation,
      ),
    ).rejects.toThrow(/guard\.worktreeCwdMismatch/);
  });

  it("远程 workspace：结构化拒绝 cwd 覆盖", async () => {
    const f = await fixture();
    const workspace = buildWorkspaceRef({
      workspaceIdentity: "remote:ssh:dev:/repo",
      workspacePath: "/repo",
    });
    await expect(
      resolveTrustedSessionWorkspace(workspace, f.cwd, f.worktreeCreation),
    ).rejects.toThrow(/guard\.worktreeCwdLocalOnly/);
  });
});

describe("resolveResumeWorkspaceRef（冷恢复/激活校验用真实 cwd）", () => {
  it("Host 传项目 workspace、存储是 worktree cwd：身份取 Host，路径取存储", () => {
    const requested = buildWorkspaceRef({ workspacePath: "/repo" });
    expect(
      resolveResumeWorkspaceRef(requested, { directory: "/worktrees/3f2a/repo/packages/ui" }),
    ).toEqual({ workspaceKey: "/repo", workspacePath: "/worktrees/3f2a/repo/packages/ui" });
  });

  it("请求路径与存储相同：沿用请求对象（保留原路径表示）", () => {
    const requested = buildWorkspaceRef({ workspacePath: "/repo/" });
    expect(resolveResumeWorkspaceRef(requested, { directory: "/repo" })).toBe(requested);
  });

  it("远程 identity：原样保留请求 workspace", () => {
    const requested = buildWorkspaceRef({
      workspaceIdentity: "remote:ssh:dev:/repo",
      workspacePath: "/repo",
    });
    expect(resolveResumeWorkspaceRef(requested, { directory: "/worktree" })).toBe(requested);
  });
});

describe("isLocalSessionDirectoryInWorkspace（受管 worktree 归属）", () => {
  it("worktree cwd 经 .git 反向链接映射回源仓库时属于项目 workspace", async () => {
    const { isLocalSessionDirectoryInWorkspace } = await import(
      "../src/nibi-protocol/workspace.js"
    );
    const managedRoot = join("/data", ".nibi", "worktrees");
    const worktreeRoot = join(managedRoot, "ab12", "repo");
    const sourceRoot = join("/src", "repo");
    const admin = join(sourceRoot, ".git", "worktrees", "repo");
    const files = new Map<string, string>([
      [join(worktreeRoot, ".git"), `gitdir: ${admin}`],
      [join(admin, "gitdir"), join(worktreeRoot, ".git")],
      [join(admin, "commondir"), "../.."],
    ]);
    const dirs = new Set([managedRoot, worktreeRoot, admin, join(sourceRoot, ".git"), sourceRoot]);
    const fs = {
      async readFile(path: string) {
        const content = files.get(path);
        if (content === undefined) throw new Error(`ENOENT ${path}`);
        return content;
      },
      async realpath(path: string) {
        return path;
      },
      async stat(path: string) {
        if (files.has(path)) return { isFile: true, isDirectory: false };
        if (dirs.has(path)) return { isFile: false, isDirectory: true };
        return null;
      },
    };
    const env = { NIBI_DATA_BASE_DIR: "/data" } as NodeJS.ProcessEnv;
    await expect(
      isLocalSessionDirectoryInWorkspace({
        directory: join(worktreeRoot, "packages", "ui"),
        workspacePath: sourceRoot,
        env,
        fs,
      }),
    ).resolves.toBe(true);
    await expect(
      isLocalSessionDirectoryInWorkspace({
        directory: join(worktreeRoot, "packages", "ui"),
        workspacePath: join("/src", "other"),
        env,
        fs,
      }),
    ).resolves.toBe(false);
    await expect(
      isLocalSessionDirectoryInWorkspace({
        directory: "/elsewhere/repo",
        workspacePath: sourceRoot,
        env,
        fs,
      }),
    ).resolves.toBe(false);
  });
});

describe("v4 createSession cwd / worktreeCreation", () => {
  it("把 Host 可信字段透传进 createSessionRecord", async () => {
    const f = await fixture();
    const createSessionRecord = vi.fn().mockResolvedValue({ sessionId: "s1" });
    recordPendingWorktreeCreation.mockClear();
    await new V4CommandExecutor(makeHost({ createSessionRecord })).execute(
      envelope("createSession", {
        workspaceId: f.project,
        cwd: f.cwd,
        worktreeCreation: f.worktreeCreation,
      }),
    );
    expect(createSessionRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: f.project,
        cwd: f.cwd,
        worktreeCreation: f.worktreeCreation,
      }),
    );
    // record 建好后先把事实记在 runtime；首轮持久化后由 runtime 落盘并投影。
    expect(recordPendingWorktreeCreation).toHaveBeenCalledWith(f.worktreeCreation);
  });

  it("worktreeCreation 缺 cwd：创建前拒绝", async () => {
    const f = await fixture();
    const createSessionRecord = vi.fn();
    await expect(
      new V4CommandExecutor(makeHost({ createSessionRecord })).execute(
        envelope("createSession", {
          workspaceId: f.project,
          worktreeCreation: f.worktreeCreation,
        }),
      ),
    ).rejects.toThrow(V4InputAdmissionRejectedError);
    expect(createSessionRecord).not.toHaveBeenCalled();
  });
});

describe("v4 forkAssistant targetCwd", () => {
  it("targetCwd 透传给 host.forkStableConversation", async () => {
    const f = await fixture();
    const target = {
      productTurnId: "turn-product-1",
      transcriptTurnId: "turn-runtime-1",
      orderedMessageIds: ["msg-user", "msg-assistant"],
      boundaryMessageId: "msg-assistant",
    };
    const resolveStableForkTarget = vi
      .fn()
      .mockResolvedValue({ ok: true, target, goalBoundary: { kind: "none" } });
    const forkStableConversation = vi
      .fn()
      .mockResolvedValue({ forkedSessionId: "s-child" });
    const targetCwd = {
      cwd: f.cwd,
      childSessionId: "s-child",
      worktreeCreation: f.worktreeCreation,
    };
    const result = await new V4CommandExecutor(
      makeHost({
        resolveRowActionTarget: () => ({ ok: true, action: "forkAssistant" }) as never,
        resolveStableForkTarget,
        forkStableConversation,
      }),
    ).execute(
      envelope("forkAssistant", { target: { rowId: 3, entityId: "entity-3" }, targetCwd }),
    );
    expect(forkStableConversation).toHaveBeenCalledWith(
      "s1",
      expect.objectContaining({ targetCwd }),
    );
    expect(result).toEqual({ type: "forkAssistant", sessionId: "s-child" });
  });
});