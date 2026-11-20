import { describe, expect, it } from "vitest";
import { readWorktreeBranches } from "./contract.example.js";

describe("managed worktree git contract", () => {
  it("reads branches and prunable records from porcelain output", () => {
    const output = [
      "worktree /work/project",
      "HEAD 1111111111111111111111111111111111111111",
      "branch refs/heads/main",
      "",
      "worktree /work/project-feature",
      "HEAD 2222222222222222222222222222222222222222",
      "branch refs/heads/feature",
      "prunable gitdir file points to non-existent location",
      "",
    ].join("\0");

    expect(readWorktreeBranches(output)).toEqual([
      { path: "/work/project", branch: "main", prunable: false },
      { path: "/work/project-feature", branch: "feature", prunable: true },
    ]);
  });

  it("returns an empty list for empty output", () => {
    expect(readWorktreeBranches("")).toEqual([]);
  });
});
