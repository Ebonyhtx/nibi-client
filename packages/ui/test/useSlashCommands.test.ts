import { describe, expect, it, beforeEach } from "vitest";
import { selectWorkspaceNibiState, useNibiSessionStore } from "../src/store/nibiSessionStore.js";

describe("useSlashCommands", () => {
  beforeEach(() => {
    useNibiSessionStore.setState((state) => ({
      ...state,
      workspaces: {},
    }));
  });

  it("remote workspace 会按 workspaceIdentity 读取 slash commands", () => {
    const workspacePath = "/root";
    const workspaceIdentity = "remote:ssh:demo:22:root:/root";
    useNibiSessionStore.getState().setSlashCommands(
      workspacePath,
      [{ name: "remote-command", description: "remote command" }],
      workspaceIdentity,
    );

    const identityCommands = selectWorkspaceNibiState(
      useNibiSessionStore.getState(),
      workspacePath,
      workspaceIdentity,
    ).slashCommands;
    const pathOnlyCommands = selectWorkspaceNibiState(useNibiSessionStore.getState(), workspacePath).slashCommands;

    expect(identityCommands.map((command) => command.name)).toEqual(["remote-command"]);
    expect(pathOnlyCommands).toEqual([]);
  });
});
