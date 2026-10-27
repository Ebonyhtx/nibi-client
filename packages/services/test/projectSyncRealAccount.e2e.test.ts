// 真实账号的云端项目 P1 验收（**手动/按需运行**，默认跳过）。
//
// 为什么不在 CI 跑：它需要两个真实 Zitadel 账号、有效会员、线上 API 与代理；CI 没有这些，
// 也不该把测试账号的令牌放进 CI。日常门禁由 projectSyncClient.test.ts / pluginUiBridgeProjectSync.test.ts
// 用假 transport 覆盖；这个文件只回答「真实服务端 + 真 token 下，创建/加入/上传/拉取/409 是否成立」。
//
// 运行方式（详见 B1 验收记录）：
//   1. 服务器上给测试账号临时授权，把两个 access token 写成 JSON（字段 token/email/zitadelUserId/membershipStatus）；
//   2. CLOUD_E2E_TOKENS_FILE=<临时 json> CLOUD_E2E_PHASE=nonmember pnpm exec vitest run \
//        packages/services/test/projectSyncRealAccount.e2e.test.ts
//   3. 给第二个账号授权后，用 CLOUD_E2E_PHASE=member 再跑一次；
//   4. 两个账号都是会员时，用 CLOUD_E2E_PHASE=merge 验自动合并/同段冲突。
//
// 令牌只从文件读，不打印；测试结束删除它创建的项目。
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ProjectSyncClient,
  readProjectManifest,
  type ProjectSyncTransport,
} from "../src/project-sync/projectSyncClient.js";

type TokenEntry = {
  token: string;
  email: string;
  zitadelUserId: string;
  membershipStatus: string;
};
type Tokens = Record<"admin" | "user", TokenEntry>;

const TOKENS_FILE = process.env.CLOUD_E2E_TOKENS_FILE ?? "";
const PHASE = process.env.CLOUD_E2E_PHASE ?? "";
const API = (process.env.CLOUD_E2E_API ?? "https://api.nibistudio.top").replace(/\/+$/u, "");
const PROXY = process.env.CLOUD_E2E_PROXY ?? "http://127.0.0.1:7897";
const maybe = TOKENS_FILE && PHASE ? describe : describe.skip;

function makeTransport(token: string): ProjectSyncTransport {
  // Node 的 global fetch 不读 HTTP_PROXY；这里显式用 undici 的 ProxyAgent，
  // 与客户端「唯一出口」纪律一致（只走代理出口，不裸连）。
  const dispatcher = new ProxyAgent(PROXY);
  const headers = { Authorization: `Bearer ${token}` };
  return {
    async request(method, path, body) {
      const response = await undiciFetch(`${API}${path}`, {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        dispatcher,
      });
      const text = await response.text();
      let parsed: unknown = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = { raw: text.slice(0, 300) };
      }
      return { status: response.status, body: parsed };
    },
    async uploadObject(path, bytes, sha256) {
      const response = await undiciFetch(`${API}${path}`, {
        method: "PUT",
        headers: {
          ...headers,
          "Content-Type": "application/octet-stream",
          "X-Nibi-Object-Sha256": sha256,
        },
        body: Buffer.from(bytes),
        dispatcher,
      });
      const text = await response.text();
      let parsed: unknown = {};
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        parsed = {};
      }
      return { status: response.status, body: parsed };
    },
    async downloadObject(path) {
      const response = await undiciFetch(`${API}${path}`, {
        method: "GET",
        headers,
        dispatcher,
      });
      if (response.status !== 200) return { status: response.status, bytes: new Uint8Array() };
      return { status: 200, bytes: new Uint8Array(await response.arrayBuffer()) };
    },
  };
}

async function makeWorkspace(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nibi-cloud-e2e-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return root;
}

maybe("云端项目 P1 真实账号验收", () => {
  let tokens: Tokens;
  const userTransport = () => makeTransport(tokens.user.token);
  const adminTransport = () => makeTransport(tokens.admin.token);
  const userClient = () => new ProjectSyncClient(userTransport(), API);
  const adminClient = () => new ProjectSyncClient(adminTransport(), API);

  beforeAll(async () => {
    if (!["nonmember", "member", "merge"].includes(PHASE)) {
      throw new Error(`CLOUD_E2E_PHASE 只能是 nonmember 或 member，收到：${PHASE}`);
    }
    tokens = JSON.parse(await readFile(TOKENS_FILE, "utf8")) as Tokens;
    if (!tokens.user?.token || !tokens.admin?.token) {
      throw new Error("token 文件缺 user/admin token");
    }
  });

  async function membershipOf(token: string): Promise<string> {
    const response = await makeTransport(token).request("GET", "/api/me");
    expect(response.status).toBe(200);
    return String((response.body as { membership?: { status?: string } }).membership?.status ?? "");
  }

  it("非会员不能创建或加入项目（PHASE=nonmember）", async () => {
    if (PHASE !== "nonmember") return;
    expect(await membershipOf(tokens.user.token)).toBe("active");
    expect(await membershipOf(tokens.admin.token)).not.toBe("active");

    const workspace = await makeWorkspace({ "说明.txt": "owner\n" });
    let projectId = "";
    try {
      const created = await userClient().createProject(`cloud-e2e-${Date.now()}`);
      projectId = created.project.id;
      expect(created.inviteCode.length).toBeGreaterThan(0);

      await expect(adminClient().createProject(`cloud-e2e-outsider-${Date.now()}`)).rejects.toThrow(
        /会员/,
      );
      await expect(adminClient().joinProject(created.inviteCode)).rejects.toThrow(/会员/);

      // 会员自己可以上传；非会员连项目都进不来。
      const uploaded = await userClient().upload(workspace, projectId, "owner v1");
      expect(uploaded.kind).toBe("committed");
      if (uploaded.kind === "committed") expect(uploaded.revision).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
      if (projectId) await userTransport().request("DELETE", `/api/v1/projects/${projectId}`);
    }
  });

  it("两个会员创建/加入/上传/拉取/409 冲突（PHASE=member）", async () => {
    if (PHASE !== "member") return;
    expect(await membershipOf(tokens.user.token)).toBe("active");
    expect(await membershipOf(tokens.admin.token)).toBe("active");

    const ownerWorkspace = await makeWorkspace({
      "共享/说明.txt": "owner-v1\n",
      "数据/样本.csv": "x,y\n1,2\n",
    });
    const editorWorkspace = await makeWorkspace({});
    let projectId = "";
    try {
      const created = await userClient().createProject(`cloud-e2e-${Date.now()}`);
      projectId = created.project.id;
      expect(created.project.role).toBe("owner");

      const first = await userClient().upload(ownerWorkspace, projectId, "owner v1");
      expect(first.kind).toBe("committed");
      if (first.kind === "committed") expect(first.revision).toBe(1);

      const joined = await adminClient().joinProject(created.inviteCode);
      expect(joined.id).toBe(projectId);
      const pulled = await adminClient().pull(editorWorkspace, projectId);
      expect(pulled.revision).toBe(1);
      expect(await readFile(join(editorWorkspace, "共享", "说明.txt"), "utf8")).toBe("owner-v1\n");

      await writeFile(join(editorWorkspace, "共享", "说明.txt"), "editor-v2\n", "utf8");
      const second = await adminClient().upload(editorWorkspace, projectId, "editor v2");
      expect(second.kind).toBe("committed");
      if (second.kind === "committed") expect(second.revision).toBe(2);

      // owner 的工作副本仍以 baseVersion=1 为基线；改了同一文件再传 -> 409，且生成冲突草稿。
      await writeFile(join(ownerWorkspace, "共享", "说明.txt"), "owner-v2-stale\n", "utf8");
      const conflict = await userClient().upload(ownerWorkspace, projectId, "owner stale");
      expect(conflict.kind).toBe("conflict");
      let draftRevision = 0;
      if (conflict.kind === "conflict") {
        expect(conflict.headVersion).toBeGreaterThan(2);
        expect(conflict.draftRevision).toBe(conflict.headVersion);
        expect(conflict.conflictingPaths).toContain("共享/说明.txt");
        draftRevision = Number(conflict.draftRevision);
      }
      expect(draftRevision).toBeGreaterThan(0);
      const resolved = await userClient().resolveConflicts(ownerWorkspace, projectId, draftRevision, {
        "共享/说明.txt": "theirs",
      });
      expect(resolved).toMatchObject({ kind: "merge", pulled: true });
      expect(await readFile(join(ownerWorkspace, "共享", "说明.txt"), "utf8")).toBe("editor-v2\n");
      expect((await readProjectManifest(ownerWorkspace))?.baseVersion).toBe(resolved.revision);
    } finally {
      await rm(ownerWorkspace, { recursive: true, force: true });
      await rm(editorWorkspace, { recursive: true, force: true });
      if (projectId) await userTransport().request("DELETE", `/api/v1/projects/${projectId}`);
    }
  });

  it("两个会员自动合并同一文件的不重叠改动，并对同段冲突返回原因（PHASE=merge）", async () => {
    if (PHASE !== "merge") return;
    expect(await membershipOf(tokens.user.token)).toBe("active");
    expect(await membershipOf(tokens.admin.token)).toBe("active");

    const ownerWorkspace = await makeWorkspace({
      "共享/说明.txt": "line1\nline2\nline3\nline4\n",
    });
    const editorWorkspace = await makeWorkspace({});
    let projectId = "";
    try {
      const created = await userClient().createProject(`cloud-e2e-merge-${Date.now()}`);
      projectId = created.project.id;
      const first = await userClient().upload(ownerWorkspace, projectId, "v1");
      expect(first.kind).toBe("committed");
      if (first.kind === "committed") expect(first.revision).toBe(1);

      await adminClient().joinProject(created.inviteCode);
      await adminClient().pull(editorWorkspace, projectId);

      await writeFile(join(ownerWorkspace, "共享", "说明.txt"), "OWNER1\nline2\nline3\nline4\n", "utf8");
      const ownerSecond = await userClient().upload(ownerWorkspace, projectId, "owner v2");
      expect(ownerSecond.kind).toBe("committed");
      if (ownerSecond.kind === "committed") expect(ownerSecond.revision).toBe(2);

      await writeFile(join(editorWorkspace, "共享", "说明.txt"), "line1\nline2\nline3\nEDITOR4\n", "utf8");
      const merged = await adminClient().upload(editorWorkspace, projectId, "editor v2 merge");
      expect(merged.kind).toBe("merged");
      if (merged.kind === "merged") {
        expect(merged.revision).toBe(3);
        expect(merged.pulled).toBe(true);
        expect(merged.parents).toEqual([1, 2]);
        expect(merged.mergedPaths).toContain("共享/说明.txt");
      }
      expect(await readFile(join(editorWorkspace, "共享", "说明.txt"), "utf8")).toBe(
        "OWNER1\nline2\nline3\nEDITOR4\n",
      );
      expect((await readProjectManifest(editorWorkspace))?.baseVersion).toBe(3);

      await userClient().pull(ownerWorkspace, projectId);
      await writeFile(join(ownerWorkspace, "共享", "说明.txt"),
        "OWNER1\nOWNER2\nline3\nEDITOR4\n", "utf8");
      const ownerFourth = await userClient().upload(ownerWorkspace, projectId, "owner v4");
      expect(ownerFourth.kind).toBe("committed");
      if (ownerFourth.kind === "committed") expect(ownerFourth.revision).toBe(4);

      await writeFile(join(editorWorkspace, "共享", "说明.txt"),
        "OWNER1\nEDITOR2\nline3\nEDITOR4\n", "utf8");
      const conflict = await adminClient().upload(editorWorkspace, projectId, "editor conflict");
      expect(conflict.kind).toBe("conflict");
      let draftRevision = 0;
      if (conflict.kind === "conflict") {
        expect(conflict.headVersion).toBeGreaterThan(4);
        expect(conflict.draftRevision).toBe(conflict.headVersion);
        expect(conflict.conflictingPaths).toContain("共享/说明.txt");
        expect(conflict.conflicts?.[0]?.reason).toBe("both_modified_text");
        draftRevision = Number(conflict.draftRevision);
      }
      expect(draftRevision).toBeGreaterThan(0);
      const resolved = await adminClient().resolveConflicts(
        editorWorkspace,
        projectId,
        draftRevision,
        { "共享/说明.txt": "theirs" },
      );
      expect(resolved).toMatchObject({ kind: "merge", pulled: true });
      expect(await readFile(join(editorWorkspace, "共享", "说明.txt"), "utf8")).toBe(
        "OWNER1\nOWNER2\nline3\nEDITOR4\n",
      );
      expect((await readProjectManifest(editorWorkspace))?.baseVersion).toBe(resolved.revision);
    } finally {
      await rm(ownerWorkspace, { recursive: true, force: true });
      await rm(editorWorkspace, { recursive: true, force: true });
      if (projectId) await userTransport().request("DELETE", `/api/v1/projects/${projectId}`);
    }
  });
});
