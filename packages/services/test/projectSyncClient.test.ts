import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ProjectSyncClient,
  readProjectManifest,
  type ProjectSyncTransport,
  type VersionFileSet,
} from "../src/project-sync/projectSyncClient.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encoder = new TextEncoder();

class MemoryProjectServer implements ProjectSyncTransport {
  readonly objects = new Map<string, Uint8Array>();
  readonly versions = new Map<number, VersionFileSet>();
  head = 0;
  projectId = "p-1";
  uploads = 0;
  mergeResponse: {
    revision: number;
    files: Record<string, string>;
    deleted: string[];
    mergedPaths: string[];
  } | null = null;
  upToDate = false;
  conflictDetails: unknown[] = [];
  conflictDraftRevision: number | null = null;
  resolveResponse: {
    kind: "merge" | "draft";
    revision: number;
    resolved: number;
    conflictsRemaining: unknown[];
  } | null = null;
  lastResolve: { revision: number; choices: Record<string, string> } | null = null;
  constructor() {
    this.versions.set(0, { revision: 0, files: {}, deleted: [] });
  }

  async request(method: string, path: string, body?: unknown) {
    if (method === "GET" && path === `/api/v1/projects/${this.projectId}`) {
      return {
        status: 200,
        body: {
          code: 0,
          data: {
            project: {
              id: this.projectId,
              name: "测试项目",
              role: "editor",
              headVersion: this.head,
            },
            members: [],
          },
        },
      };
    }
    if (method === "POST" && path === `/api/v1/projects/${this.projectId}/versions`) {
      const input = body as {
        baseVersion: number;
        files: Record<string, string>;
        deleted: string[];
      };
      if (input.baseVersion !== this.head) {
        if (this.mergeResponse) {
          this.head = this.mergeResponse.revision;
          this.versions.set(this.head, {
            revision: this.head,
            files: this.mergeResponse.files,
            deleted: this.mergeResponse.deleted,
            message: "自动合并",
            parents: [input.baseVersion, this.head - 1],
          });
          return {
            status: 200,
            body: {
              code: 0,
              data: {
                kind: "merged",
                revision: this.head,
                baseVersion: input.baseVersion,
                headVersion: this.head,
                parents: [input.baseVersion, this.head - 1],
                mergedPaths: this.mergeResponse.mergedPaths,
                takenRemotePaths: [],
                takenLocalPaths: [],
                conflicts: [],
              },
            },
          };
        }
        if (this.upToDate) {
          return {
            status: 200,
            body: {
              code: 0,
              data: { kind: "up_to_date", headVersion: this.head, mergedPaths: [], conflicts: [] },
            },
          };
        }
        return {
          status: 409,
          body: {
            code: 4009,
            msg: "云端已更新，请先拉取最新版本",
            data: {
              headVersion: this.head,
              draftRevision: this.conflictDraftRevision,
              conflictingPaths: this.conflictDetails.length
                ? (this.conflictDetails as Array<{ path: string }>).map((item) => item.path)
                : [],
              conflicts: this.conflictDetails,
            },
          },
        };
      }
      this.head += 1;
      this.versions.set(this.head, {
        revision: this.head,
        files: input.files,
        deleted: input.deleted,
      });
      return { status: 200, body: { code: 0, data: { revision: this.head } } };
    }
    const resolveMatch = /\/versions\/(\d+)\/resolve$/u.exec(path);
    if (method === "POST" && resolveMatch) {
      this.lastResolve = {
        revision: Number(resolveMatch[1]),
        choices: (body as { choices: Record<string, string> }).choices,
      };
      if (!this.resolveResponse) return { status: 404, body: { code: 4004, msg: "not found" } };
      if (this.resolveResponse.kind === "merge") {
        this.head = this.resolveResponse.revision;
        this.versions.set(this.head, {
          revision: this.head,
          files: {},
          deleted: [],
          message: "resolved",
        });
      }
      return { status: 200, body: { code: 0, data: this.resolveResponse } };
    }
    const versionMatch = /\/versions\/(\d+)$/u.exec(path);
    if (method === "GET" && versionMatch) {
      const version = this.versions.get(Number(versionMatch[1]));
      if (!version) return { status: 404, body: { code: 4004, msg: "版本不存在" } };
      return { status: 200, body: { code: 0, data: version } };
    }
    return { status: 404, body: { code: 4004, msg: "not found" } };
  }

  async uploadObject(_path: string, bytes: Uint8Array, hash: string) {
    this.uploads += 1;
    this.objects.set(hash, bytes);
    return { status: 200, body: { code: 0, data: { sha256: hash } } };
  }

  async downloadObject(path: string) {
    const hash = path.split("/").at(-1) ?? "";
    const bytes = this.objects.get(hash);
    return bytes
      ? { status: 200, bytes }
      : { status: 404, bytes: new Uint8Array() };
  }
}

let workspace: string | null = null;
afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = null;
});

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nibi-project-sync-"));
  await mkdir(join(root, "题目"), { recursive: true });
  await mkdir(join(root, "状态"), { recursive: true });
  await writeFile(join(root, "题目", "a.md"), "第一版");
  await writeFile(join(root, "状态", "进度.json"), "{\"stage\":1}");
  workspace = root;
  return root;
}

describe("ProjectSyncClient", () => {
  it("首轮上传全部对象并写清单；改动后只传变化的对象", async () => {
    const root = await makeWorkspace();
    const server = new MemoryProjectServer();
    const client = new ProjectSyncClient(server, "https://api.example");

    const first = await client.upload(root, server.projectId, "v1");
    expect(first).toMatchObject({ kind: "committed", revision: 1, uploadedObjects: 2 });
    expect(server.uploads).toBe(2);
    const manifest = await readProjectManifest(root);
    expect(manifest?.baseVersion).toBe(1);
    expect(Object.keys(manifest?.baseFiles ?? {}).sort()).toEqual(["状态/进度.json", "题目/a.md"]);

    await writeFile(join(root, "题目", "a.md"), "第二版");
    const second = await client.upload(root, server.projectId, "v2");
    expect(second).toMatchObject({ kind: "committed", revision: 2, uploadedObjects: 1 });
    expect(server.uploads).toBe(3);
  });

  it("base 落后时返回 409，且不改本地清单", async () => {
    const root = await makeWorkspace();
    const server = new MemoryProjectServer();
    const client = new ProjectSyncClient(server);
    await client.upload(root, server.projectId);
    const before = await readProjectManifest(root);

    server.head = 5; // 另一端已经提交
    await writeFile(join(root, "题目", "a.md"), "本地改动");
    const result = await client.upload(root, server.projectId);
    expect(result).toMatchObject({ kind: "conflict", headVersion: 5 });
    expect(await readProjectManifest(root)).toEqual(before);
  });

  it("服务端自动合并后，拉取合并版本并更新本地清单", async () => {
    const root = await makeWorkspace();
    const server = new MemoryProjectServer();
    const client = new ProjectSyncClient(server);
    await client.upload(root, server.projectId);
    const base = server.versions.get(1)!;
    const mergedBytes = encoder.encode("合并后的内容");
    const mergedSha = sha(mergedBytes);
    server.objects.set(mergedSha, mergedBytes);
    server.head = 2;
    server.mergeResponse = {
      revision: 2,
      files: {
        "题目/a.md": mergedSha,
        "状态/进度.json": base.files["状态/进度.json"]!,
      },
      deleted: [],
      mergedPaths: ["题目/a.md"],
    };
    await writeFile(join(root, "题目", "a.md"), "本地改动");

    const result = await client.upload(root, server.projectId, "本地改动");
    expect(result).toMatchObject({ kind: "merged", revision: 2, pulled: true });
    expect(await readFile(join(root, "题目", "a.md"), "utf8")).toBe("合并后的内容");
    expect((await readProjectManifest(root))?.baseVersion).toBe(2);
  });

  it("云端已包含本地改动时返回 up_to_date 并同步清单", async () => {
    const root = await makeWorkspace();
    const server = new MemoryProjectServer();
    const client = new ProjectSyncClient(server);
    await client.upload(root, server.projectId);
    server.head = 2;
    server.versions.set(2, { revision: 2, files: {}, deleted: [], message: "remote" });
    server.upToDate = true;
    await writeFile(join(root, "题目", "a.md"), "本地改动");

    const result = await client.upload(root, server.projectId);
    expect(result).toMatchObject({ kind: "up_to_date", headVersion: 2, pulled: true });
    expect((await readProjectManifest(root))?.baseVersion).toBe(2);
  });

  it("冲突返回逐文件原因", async () => {
    const root = await makeWorkspace();
    const server = new MemoryProjectServer();
    const client = new ProjectSyncClient(server);
    await client.upload(root, server.projectId);
    server.head = 5;
    server.conflictDraftRevision = 6;
    server.conflictDetails = [
      {
        path: "题目/a.md",
        reason: "both_modified_text",
        baseSha: null,
        headSha: null,
        localSha: null,
      },
    ];
    await writeFile(join(root, "题目", "a.md"), "本地改动");
    const result = await client.upload(root, server.projectId);
    expect(result).toMatchObject({ kind: "conflict", headVersion: 5, draftRevision: 6 });
    expect(result.kind === "conflict" ? result.conflicts?.[0]?.reason : null).toBe(
      "both_modified_text",
    );
  });

  it("逐文件选边全部解决后自动拉取新版本", async () => {
    const root = await makeWorkspace();
    const server = new MemoryProjectServer();
    const client = new ProjectSyncClient(server);
    await client.upload(root, server.projectId);
    server.resolveResponse = {
      kind: "merge",
      revision: 5,
      resolved: 1,
      conflictsRemaining: [],
    };

    const result = await client.resolveConflicts(root, server.projectId, 4, {
      "题目/a.md": "theirs",
    });
    expect(result).toMatchObject({ kind: "merge", revision: 5, resolved: 1, pulled: true });
    expect(server.lastResolve).toEqual({
      revision: 4,
      choices: { "题目/a.md": "theirs" },
    });
    expect((await readProjectManifest(root))?.baseVersion).toBe(5);
  });

  it("部分解决保持 draft，不拉取本地", async () => {
    const root = await makeWorkspace();
    const server = new MemoryProjectServer();
    const client = new ProjectSyncClient(server);
    await client.upload(root, server.projectId);
    server.resolveResponse = {
      kind: "draft",
      revision: 5,
      resolved: 1,
      conflictsRemaining: [
        { path: "题目/b.md", reason: "both_modified_text", baseSha: null, headSha: null, localSha: null },
      ],
    };
    const before = await readProjectManifest(root);

    const result = await client.resolveConflicts(root, server.projectId, 4, {
      "题目/a.md": "ours",
    });
    expect(result).toMatchObject({ kind: "draft", revision: 5, resolved: 1, pulled: false });
    expect(result.conflictsRemaining).toHaveLength(1);
    expect(await readProjectManifest(root)).toEqual(before);
  });

  it("拉取 head 版本：覆盖前备份、下载校验、更新清单", async () => {
    const root = await makeWorkspace();
    const server = new MemoryProjectServer();
    const client = new ProjectSyncClient(server);
    await client.upload(root, server.projectId);

    const remoteBytes = encoder.encode("远端新版");
    const remoteSha = sha(remoteBytes);
    server.objects.set(remoteSha, remoteBytes);
    server.head = 2;
    server.versions.set(2, {
      revision: 2,
      files: { "题目/a.md": remoteSha, "图表/new.txt": sha(encoder.encode("新增")) },
      deleted: ["状态/进度.json"],
      message: "remote",
    });
    server.objects.set(sha(encoder.encode("新增")), encoder.encode("新增"));

    const pulled = await client.pull(root, server.projectId);
    expect(pulled).toMatchObject({ revision: 2, written: 2, removed: 1 });
    expect(pulled.backupDir).toBeTruthy();
    expect(await readFile(join(root, "题目", "a.md"), "utf8")).toBe("远端新版");
    expect(existsSync(join(root, "状态", "进度.json"))).toBe(false);
    expect((await readProjectManifest(root))?.baseVersion).toBe(2);
    expect(await readdir(join(root, ".nibi-project-backups"))).toHaveLength(1);
  });
});
