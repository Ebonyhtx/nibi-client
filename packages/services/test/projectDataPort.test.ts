import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createProjectDataPort, directoryBytes } from "../src/project/data/project-data-port.js";

const roots: string[] = [];
async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "project-data-port-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("measure 统计真实文件，checkpoint 缺失按 0", async () => {
  const root = await tempRoot();
  const checkpoint = join(root, "checkpoints", "work");
  await mkdir(checkpoint, { recursive: true });
  await writeFile(join(checkpoint, "one.json"), "1234567890");
  await writeFile(join(checkpoint, "two.json"), "12345");
  const port = createProjectDataPort({
    agent: {
      measure: vi.fn(async () => ({
        sessions: [{ sessionId: "s1", bytes: 42 }],
        memory: [{ workspacePath: "/work", bytes: 7 }],
      })),
      purge: vi.fn(async () => ({ deleted: [], kept: [], failed: [], memory: [] })),
    },
    checkpointDirectory: (path) => join(root, "checkpoints", path),
  });
  expect(await directoryBytes(checkpoint)).toBe(15);
  expect(await directoryBytes(join(root, "missing"))).toBe(0);
  expect(
    await port.measure({
      sessions: [{ sessionId: "s1", cwd: "/work" }],
      directories: ["/work", "/absent"],
    }),
  ).toEqual({
    sessions: [{ sessionId: "s1", bytes: 42 }],
    directories: [
      { path: "/work", memoryBytes: 7, checkpointBytes: 15 },
      { path: "/absent", memoryBytes: 0, checkpointBytes: 0 },
    ],
  });
});

it("purgeSessions 按 cwd 串行分组，单组失败按会话计入可重试失败", async () => {
  const root = await tempRoot();
  const purge = vi.fn(async (params: { workspace: { workspacePath: string } }) => {
    if (params.workspace.workspacePath === "/bad") throw new Error("boom");
    return {
      deleted: [{ sessionId: params.sessionIds[0]!, bytes: 1 }],
      kept: [],
      failed: [],
      memory: [],
    };
  });
  const port = createProjectDataPort({
    agent: {
      measure: vi.fn(),
      purge,
    },
    checkpointDirectory: (path) => join(root, path),
  });
  const result = await port.purgeSessions([
    { sessionId: "a", cwd: "/good" },
    { sessionId: "b", cwd: "/good" },
    { sessionId: "c", cwd: "/bad" },
  ]);
  expect(purge.mock.calls.map((call) => call[0].workspace.workspacePath)).toEqual([
    "/good",
    "/bad",
  ]);
  expect(result.deleted.map((entry) => entry.sessionId)).toEqual(["a"]);
  expect(result.failed).toEqual([{ sessionId: "c", code: "project.data-session-purge-failed" }]);
});

it("purgeDirectories 先删 CLI 记忆再删 Host checkpoint，重复调用按 0 字节", async () => {
  const root = await tempRoot();
  const checkpoint = join(root, "checkpoints", "/work");
  await mkdir(checkpoint, { recursive: true });
  await writeFile(join(checkpoint, "manifest.json"), "123456");
  const purge = vi.fn(async (params: { directories: Array<{ workspacePath: string }> }) => ({
    deleted: [],
    kept: [],
    failed: [],
    memory: params.directories.map((entry) => ({ workspacePath: entry.workspacePath, bytes: 6 })),
  }));
  const port = createProjectDataPort({
    agent: { measure: vi.fn(), purge },
    checkpointDirectory: (path) => join(root, "checkpoints", path),
  });

  const first = await port.purgeDirectories(["/work"]);
  expect(first).toEqual({
    memory: [{ workspacePath: "/work", bytes: 6 }],
    checkpoints: [{ workspacePath: "/work", bytes: 6 }],
    failed: [],
  });
  await expect(directoryBytes(checkpoint)).resolves.toBe(0);
  expect(await port.purgeDirectories(["/work"])).toEqual({
    memory: [{ workspacePath: "/work", bytes: 6 }],
    checkpoints: [{ workspacePath: "/work", bytes: 0 }],
    failed: [],
  });
});

it("CLI 目录删除失败时仍尝试 Host checkpoint，并保留失败路径", async () => {
  const root = await tempRoot();
  const checkpoint = join(root, "checkpoints", "/work");
  await mkdir(checkpoint, { recursive: true });
  await writeFile(join(checkpoint, "manifest.json"), "1");
  const port = createProjectDataPort({
    agent: {
      measure: vi.fn(),
      purge: vi.fn(async () => ({
        deleted: [],
        kept: [],
        failed: [{ workspacePath: "/work", code: "storage.permission" }],
        memory: [],
      })),
    },
    checkpointDirectory: (path) => join(root, "checkpoints", path),
  });
  const result = await port.purgeDirectories(["/work"]);
  expect(result.checkpoints).toEqual([{ workspacePath: "/work", bytes: 1 }]);
  expect(result.failed).toEqual([{ workspacePath: "/work", code: "storage.permission" }]);
  await expect(directoryBytes(checkpoint)).resolves.toBe(0);
});
