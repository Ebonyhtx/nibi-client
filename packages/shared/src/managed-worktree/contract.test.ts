import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeManagedWorktreePlacement } from "./contract.example.js";
import { parseManagedWorktreePath, resolveManagedWorktreeRoot } from "./index.js";

describe("managed worktree shared contract", () => {
  it("maps a source tree into the managed bucket and parses it back", () => {
    const sourceRoot = join("work", "project");
    const placement = describeManagedWorktreePlacement({
      dataBaseDir: join("data"),
      sourceRoot,
      worktreeName: "project",
    });

    expect(placement.managedRoot.endsWith(join(".nibi", "worktrees"))).toBe(true);
    expect(placement.parsed).toMatchObject({
      bucket: "0a1b",
      name: "project",
      worktreeRoot: placement.worktreeRoot,
    });
    expect(placement.parsed?.relativePath).toBe(join("src", "index.ts"));
    expect(placement.mapped).toEqual([
      placement.worktreeRoot,
      join(placement.worktreeRoot, "packages", "app"),
    ]);
  });

  it("rejects a path outside the managed root", () => {
    const managedRoot = resolveManagedWorktreeRoot(join("data"));
    expect(parseManagedWorktreePath(managedRoot, join("work", "project", "src"))).toBeNull();
    expect(parseManagedWorktreePath(managedRoot, managedRoot)).toBeNull();
  });
});
