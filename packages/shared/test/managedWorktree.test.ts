import { describe, expect, it } from "vitest";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  MANAGED_WORKTREE_HOME_SEGMENTS,
  isManagedWorktreeBucket,
  isPathInside,
  isSamePath,
  mapProjectRootsIntoWorktree,
  parseManagedWorktreePath,
  resolveManagedWorktreeRoot,
  resolveWorkspaceHookTrustIdentity,
  type WorkspaceHookTrustIdentityFs,
} from "../src/managed-worktree/index.js";

describe("managed worktree layout", () => {
  it("resolves the managed root under the data base dir", () => {
    expect(MANAGED_WORKTREE_HOME_SEGMENTS).toEqual([".nibi", "worktrees"]);
    expect(resolveManagedWorktreeRoot("/data")).toBe(join("/data", ".nibi", "worktrees"));
  });

  it("parses bucket/name and nested relative paths", () => {
    const root = resolveManagedWorktreeRoot("/data");
    const parts = parseManagedWorktreePath(root, join(root, "ab12", "repo", "packages", "app"));
    expect(parts).toEqual({
      managedRoot: root,
      bucket: "ab12",
      name: "repo",
      worktreeRoot: join(root, "ab12", "repo"),
      relativePath: ["packages", "app"].join(sep),
    });
  });

  it("rejects paths outside the layout or with invalid buckets", () => {
    const root = resolveManagedWorktreeRoot("/data");
    expect(parseManagedWorktreePath(root, join(root, "..", "evil"))).toBeNull();
    expect(parseManagedWorktreePath(root, root)).toBeNull();
    expect(parseManagedWorktreePath(root, join(root, "AB12", "repo"))).toBeNull();
    expect(parseManagedWorktreePath(root, join(root, "abc", "repo"))).toBeNull();
    expect(parseManagedWorktreePath(root, join(root, "ab12"))).toBeNull();
    expect(isManagedWorktreeBucket("0000")).toBe(true);
    expect(isManagedWorktreeBucket("000g")).toBe(false);
  });

  it("keeps path containment case/separator aware", () => {
    expect(isPathInside("/repo", "/repo/pkg")).toBe(true);
    expect(isPathInside("/repo", "/repo")).toBe(true);
    expect(isPathInside("/repo", "/repository")).toBe(false);
    expect(isPathInside("/repo", "/repo/../other")).toBe(false);
    expect(isSamePath("/repo/a", "/repo/a")).toBe(true);
    expect(isSamePath("/repo/a", "/repo/b")).toBe(false);
    expect(isAbsolute(relative("/repo", "/repo/pkg"))).toBe(false);
  });

  it("maps project roots into the worktree and removes the cwd", () => {
    expect(
      mapProjectRootsIntoWorktree(
        ["/repo", "/repo/packages/app", "/outside"],
        { sourceRoot: "/repo", worktreeRoot: "/wt/repo", cwd: "/wt/repo/packages/app" },
      ),
    ).toEqual([join("/wt", "repo"), "/outside"]);
  });
});

interface FakeNode {
  file?: string;
  dir?: boolean;
}

function createFakeFs(
  nodes: Map<string, FakeNode>,
  links: Map<string, string> = new Map(),
): WorkspaceHookTrustIdentityFs {
  return {
    async readFile(path) {
      const node = nodes.get(path);
      if (!node?.file) throw new Error(`ENOENT ${path}`);
      return node.file;
    },
    async realpath(path) {
      return links.get(path) ?? path;
    },
    async stat(path) {
      const node = nodes.get(path);
      if (!node) return null;
      return { isFile: Boolean(node.file), isDirectory: Boolean(node.dir) };
    },
  };
}

describe("workspace hook trust identity", () => {
  const dataBaseDir = "/data";
  const managedRoot = resolveManagedWorktreeRoot(dataBaseDir);
  const worktreeRoot = join(managedRoot, "ab12", "repo");
  const workspace = join(worktreeRoot, "packages", "app");
  const adminDir = "/repo/.git/worktrees/w1";

  function managedNodes(): Map<string, FakeNode> {
    return new Map<string, FakeNode>([
      [join(worktreeRoot, ".git"), { file: `gitdir: ${adminDir}\n` }],
      [join(adminDir, "gitdir"), { file: `${join(worktreeRoot, ".git")}\n` }],
      [join(adminDir, "commondir"), { file: "../..\n" }],
      [join("/repo", ".git"), { dir: true }],
    ]);
  }

  it("returns a remote identity unchanged without touching the filesystem", async () => {
    const fs = createFakeFs(new Map());
    await expect(
      resolveWorkspaceHookTrustIdentity(
        { workspacePath: workspace, workspaceIdentity: "remote:server:s:/repo", dataBaseDir },
        fs,
      ),
    ).resolves.toBe("remote:server:s:/repo");
  });

  it("maps a verified managed worktree back to the source repository path", async () => {
    const fs = createFakeFs(managedNodes());
    await expect(
      resolveWorkspaceHookTrustIdentity({ workspacePath: workspace, dataBaseDir }, fs),
    ).resolves.toBe(join("/repo", "packages", "app"));
  });

  it("fails closed to the workspace path when the backlink does not match", async () => {
    const nodes = managedNodes();
    nodes.set(join(adminDir, "gitdir"), { file: "/somewhere/else/.git\n" });
    const fs = createFakeFs(nodes);
    await expect(
      resolveWorkspaceHookTrustIdentity({ workspacePath: workspace, dataBaseDir }, fs),
    ).resolves.toBe(workspace);
  });

  it("does not inherit for ordinary directories", async () => {
    const fs = createFakeFs(new Map([["/plain", { dir: true }]]));
    await expect(
      resolveWorkspaceHookTrustIdentity({ workspacePath: "/plain", dataBaseDir }, fs),
    ).resolves.toBe("/plain");
  });
});