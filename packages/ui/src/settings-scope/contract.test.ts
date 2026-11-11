import { describe, expect, it } from "vitest";
import type {
  ConfigWorkspaceTarget,
  SettingsScopeContext,
  SettingsScopeDeviceState,
} from "./contract.js";
import {
  LOCAL_USER_SCOPE_KEY,
  buildSettingsScopeGroups,
  isPluginScopeWorkspaceConnected,
  isUserScopeKey,
  parseRemoteUserScopeKey,
  remoteUserScopeKey,
  resolveDefaultSettingsScopeKey,
  resolveSettingsScope,
} from "./index.js";
import { resolveSettingsScopeBlock } from "./ui/SettingsScopeBlockedNotice.js";
import { settingsScopeModule } from "./module.js";

const localTarget = (workspacePath: string): ConfigWorkspaceTarget => ({
  workspacePath,
  label: workspacePath.split("/").pop() || workspacePath,
});

const remoteTarget = (
  identity: string,
  overrides: Partial<ConfigWorkspaceTarget> = {},
): ConfigWorkspaceTarget => ({
  workspacePath: identity.split(":").slice(-1)[0] ?? "/repo",
  workspaceIdentity: identity,
  label: "repo",
  remoteSessionId: "session-1",
  ...overrides,
});

const device = (
  sourceServerId: string,
  online: boolean,
  name = sourceServerId,
): SettingsScopeDeviceState => ({ sourceServerId, name, online });

const context = (overrides: Partial<SettingsScopeContext> = {}): SettingsScopeContext => ({
  targets: [],
  devices: [],
  remoteUserAvailable: true,
  ...overrides,
});

describe("settings-scope contract", () => {
  it("declares its module manifest", () => {
    expect(settingsScopeModule.id).toBe("settings-scope");
    expect(settingsScopeModule.publicEntrypoints).toContain("contract.ts");
  });

  it("parses and builds page-level Scope keys", () => {
    expect(remoteUserScopeKey("source-a")).toBe("source-user:source-a");
    expect(parseRemoteUserScopeKey("source-user:source-a")).toBe("source-a");
    expect(parseRemoteUserScopeKey("source-user:")).toBeNull();
    expect(parseRemoteUserScopeKey("user")).toBeNull();
    expect(isUserScopeKey(LOCAL_USER_SCOPE_KEY)).toBe(true);
    expect(isUserScopeKey("source-user:source-a")).toBe(true);
    expect(isUserScopeKey("/repo")).toBe(false);
  });

  it("groups 本机在前，在线设备各一组，离线设备整组不列出", () => {
    const localA = localTarget("/local/a");
    const localB = localTarget("/local/b");
    const remoteA = remoteTarget("remote:server:source-a:/work/a");
    const remoteB = remoteTarget("remote:server:source-b:/work/b");
    const remoteDirect = remoteTarget("remote:ssh:host-b:22:dev:/work/direct");
    const groups = buildSettingsScopeGroups(
      context({
        targets: [localB, remoteB, localA, remoteA, remoteDirect],
        devices: [device("source-a", true, "Device A"), device("source-b", false, "Device B")],
      }),
    );

    expect(
      groups.map((group) => (group.device.kind === "local" ? "local" : group.device.id)),
    ).toEqual(["local", "source-a", "remote:ssh:host-b:22:dev"]);
    expect(groups[0]?.options.map((option) => option.key)).toEqual([
      "user",
      "/local/b",
      "/local/a",
    ]);
    expect(groups[1]?.device.kind === "remote" && groups[1].device.name).toBe("Device A");
    expect(groups[1]?.options.map((option) => option.key)).toEqual([
      "source-user:source-a",
      "remote:server:source-a:/work/a",
    ]);
    // 离线 Source B 的项目不列出；没有设备记录的远端项目仍可配置，但不提供「用户」。
    expect(groups.flatMap((group) => group.options.map((option) => option.key))).not.toContain(
      "remote:server:source-b:/work/b",
    );
    expect(groups[2]?.options.map((option) => option.key)).toEqual([
      "remote:ssh:host-b:22:dev:/work/direct",
    ]);
    expect(groups[2]?.options.some((option) => option.kind === "user")).toBe(false);
  });

  it("平台不能申请 attachment 时远端设备没有「用户」选项", () => {
    const groups = buildSettingsScopeGroups(
      context({
        targets: [remoteTarget("remote:server:source-a:/work/a")],
        devices: [device("source-a", true)],
        remoteUserAvailable: false,
      }),
    );
    expect(groups[1]?.options.map((option) => option.key)).toEqual([
      "remote:server:source-a:/work/a",
    ]);
  });

  it("已失效的项目不进入菜单", () => {
    const unavailable = remoteTarget("remote:server:source-a:/work/a", {
      remoteSessionId: undefined,
      configOnline: false,
    });
    expect(isPluginScopeWorkspaceConnected(unavailable)).toBe(false);
    const groups = buildSettingsScopeGroups(
      context({ targets: [unavailable], devices: [device("source-a", true)] }),
    );
    expect(groups.map((group) => group.options.length)).toEqual([1, 1]);
    expect(groups.flatMap((group) => group.options.map((option) => option.key))).not.toContain(
      "remote:server:source-a:/work/a",
    );
  });

  it("默认选中当前 workspace 所在设备的「用户」", () => {
    expect(
      resolveDefaultSettingsScopeKey({ workspacePath: "/repo", remoteUserAvailable: true }),
    ).toBe("user");
    expect(
      resolveDefaultSettingsScopeKey({
        workspacePath: "/work/a",
        workspaceIdentity: "remote:server:source-a:/work/a",
        remoteUserAvailable: true,
      }),
    ).toBe("source-user:source-a");
    // Web / 手机没有远端「用户」：远程 tab 默认选中当前远程项目本身。
    expect(
      resolveDefaultSettingsScopeKey({
        workspacePath: "/work/a",
        workspaceIdentity: "remote:server:source-a:/work/a",
        remoteUserAvailable: false,
      }),
    ).toBe("remote:server:source-a:/work/a");
  });

  it("resolveSettingsScope：用户目标 ready / offline / missing", () => {
    const ctx = context({
      targets: [localTarget("/repo"), remoteTarget("remote:server:source-a:/work/a")],
      devices: [device("source-a", true), device("source-b", false)],
    });
    expect(resolveSettingsScope("user", ctx)).toMatchObject({
      status: "ready",
      kind: "user",
      device: { kind: "local" },
    });
    expect(resolveSettingsScope("source-user:source-a", ctx)).toMatchObject({
      status: "ready",
      kind: "user",
      device: { kind: "remote", id: "source-a" },
    });
    expect(resolveSettingsScope("source-user:source-b", ctx)).toMatchObject({
      status: "offline",
      device: { kind: "remote", id: "source-b" },
    });
    // 平台没有 attachment 能力时远端「用户」不存在，按缺失回退到本机「用户」。
    expect(
      resolveSettingsScope("source-user:source-a", { ...ctx, remoteUserAvailable: false }),
    ).toEqual({ status: "missing", key: "source-user:source-a", fallbackKey: "user" });
  });

  it("resolveSettingsScope：显式项目未解析时缺失，设备离线时 fail-closed，同设备项目关闭回退设备「用户」", () => {
    const ctx = context({
      targets: [
        localTarget("/repo"),
        remoteTarget("remote:server:source-a:/work/a"),
        remoteTarget("remote:server:source-b:/work/b"),
      ],
      devices: [device("source-a", true), device("source-b", false)],
    });
    // 目录尚未加载 / 项目根本不存在：不会临时展示「用户」的可写快照。
    expect(resolveSettingsScope("/not-loaded", ctx)).toEqual({
      status: "missing",
      key: "/not-loaded",
      fallbackKey: "user",
    });
    expect(resolveSettingsScope("remote:server:source-b:/work/b", ctx)).toMatchObject({
      status: "offline",
      device: { kind: "remote", id: "source-b" },
    });
    // 设备仍在线但项目已关闭：回退到同一设备的「用户」，不回退本机。
    expect(resolveSettingsScope("remote:server:source-a:/gone", ctx)).toEqual({
      status: "missing",
      key: "remote:server:source-a:/gone",
      fallbackKey: "source-user:source-a",
    });
    // 本机项目关闭回退本机「用户」。
    expect(resolveSettingsScope("/gone", ctx)).toEqual({
      status: "missing",
      key: "/gone",
      fallbackKey: "user",
    });
  });

  it("resolveSettingsScopeBlock：加载与离线都不渲染可写列表", () => {
    expect(
      resolveSettingsScopeBlock(
        {
          resolution: { status: "missing", key: "/x", fallbackKey: "user" },
          user: { status: "offline" },
        },
        true,
      ),
    ).toBe("connecting");
    expect(
      resolveSettingsScopeBlock(
        {
          resolution: {
            status: "offline",
            key: "source-user:a",
            device: { kind: "remote", id: "a", sourceServerId: "a", name: "A" },
          },
          user: { status: "offline" },
        },
        true,
      ),
    ).toBe("offline");
    expect(
      resolveSettingsScopeBlock(
        {
          resolution: { status: "ready", key: "user", kind: "user", device: { kind: "local" } },
          user: { status: "connecting" },
        },
        true,
      ),
    ).toBe("connecting");
    expect(
      resolveSettingsScopeBlock(
        {
          resolution: { status: "ready", key: "user", kind: "user", device: { kind: "local" } },
          user: { status: "ready", target: localTarget("/repo"), unscopedServices: {} as never },
        },
        true,
      ),
    ).toBeNull();
    // 选中项目时不看「用户」的 attachment 状态。
    expect(
      resolveSettingsScopeBlock(
        {
          resolution: {
            status: "ready",
            key: "/repo",
            kind: "workspace",
            device: { kind: "local" },
            target: localTarget("/repo"),
          },
          user: { status: "offline" },
        },
        false,
      ),
    ).toBeNull();
  });
});
