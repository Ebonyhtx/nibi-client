// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@nibi/services";
import type { ConfigWorkspaceTarget } from "../contract.js";
import { registerSourceSettingsServices } from "@/store/sourceSettingsServiceStore.js";
import { useSettingsScope } from "../index.js";

const state = vi.hoisted(() => ({
  platform: null as {
    requestSourceSettingsAttachment: (id: string) => Promise<{ attachmentId: string }>;
  } | null,
  targets: [] as ConfigWorkspaceTarget[],
  loaded: false,
  inputs: new Map<string, Record<string, unknown>>(),
  base: {
    systemService: { info: async () => ({ homedir: "/home/local" }) },
  } as unknown as IServiceAccessor,
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => state.platform,
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => state.base,
}));
vi.mock("@/hooks/useSourceServerStatuses.js", () => ({
  useRemoteDevicePresentationInputs: () => state.inputs,
}));
vi.mock("@/workspace-config-catalog/index.js", () => ({
  useConfigWorkspaceTargets: () => ({ targets: state.targets, loaded: state.loaded }),
}));

const remoteTarget = (identity: string): ConfigWorkspaceTarget => ({
  workspacePath: identity.slice(identity.lastIndexOf(":") + 1),
  workspaceIdentity: identity,
  label: "repo",
  remoteSessionId: "session-1",
});

const localTarget = (workspacePath: string): ConfigWorkspaceTarget => ({
  workspacePath,
  label: workspacePath.split("/").pop() || workspacePath,
});

function servicesWithHome(homedir: string, deferred?: Promise<string>) {
  const info = vi.fn(async () => {
    const value = deferred ? await deferred : homedir;
    return { homedir: value };
  });
  return { services: { systemService: { info } } as unknown as IServiceAccessor, info };
}

const releases: Array<() => void> = [];

function register(sourceServerId: string, services: IServiceAccessor) {
  const release = registerSourceSettingsServices({
    sourceServerId,
    attachmentId: `${sourceServerId}-attachment`,
    services,
    dispose: vi.fn(),
  });
  releases.push(release);
  return release;
}

beforeEach(() => {
  state.platform = { requestSourceSettingsAttachment: vi.fn(async () => ({ attachmentId: "a" })) };
  state.targets = [];
  state.loaded = false;
  state.inputs = new Map();
  state.base = {
    systemService: { info: async () => ({ homedir: "/home/local" }) },
  } as unknown as IServiceAccessor;
});

afterEach(() => {
  cleanup();
  while (releases.length > 0) releases.pop()?.();
});

describe("useSettingsScope", () => {
  it("离线设备不列出、不提供用户服务，也不申请 attachment（fail-closed）", async () => {
    state.targets = [localTarget("/repo"), remoteTarget("remote:server:source-a:/work/a")];
    state.inputs = new Map([["source-a", { state: "offline", displayName: "Device A" }]]);
    const request = vi.fn(async () => ({ attachmentId: "a" }));
    state.platform = { requestSourceSettingsAttachment: request };

    const { result } = renderHook(() =>
      useSettingsScope({
        workspacePath: "/repo",
        initialScopeKey: "source-user:source-a",
      }),
    );

    expect(
      result.current.groups.flatMap((group) => group.options.map((option) => option.key)),
    ).not.toContain("source-user:source-a");
    expect(result.current.resolution).toMatchObject({ status: "offline" });
    expect(result.current.user).toEqual({ status: "offline" });
    expect(result.current.syncSourceServerId).toBeNull();
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
  });

  it("Web / 手机没有远端「用户」：分组只列项目，远程 tab 默认选中当前远程项目", () => {
    state.platform = null;
    state.targets = [remoteTarget("remote:server:source-a:/work/a")];
    state.inputs = new Map([["source-a", { state: "online", displayName: "Device A" }]]);

    const { result } = renderHook(() =>
      useSettingsScope({
        workspacePath: "/work/a",
        workspaceIdentity: "remote:server:source-a:/work/a",
      }),
    );

    expect(
      result.current.groups.flatMap((group) => group.options.map((option) => option.key)),
    ).not.toContain("source-user:source-a");
    expect(result.current.selectedScopeKey).toBe("remote:server:source-a:/work/a");
    expect(result.current.resolution).toMatchObject({ status: "ready", kind: "workspace" });
  });

  it("远端「用户」经 attachment + home 就绪；切换设备后迟到的 home 结果被丢弃", async () => {
    state.targets = [
      remoteTarget("remote:server:source-a:/work/a"),
      remoteTarget("remote:server:source-b:/work/b"),
    ];
    state.inputs = new Map([
      ["source-a", { state: "online", displayName: "Device A" }],
      ["source-b", { state: "online", displayName: "Device B" }],
    ]);
    let resolveHomeA!: (value: string) => void;
    const homeA = new Promise<string>((resolve) => {
      resolveHomeA = resolve;
    });
    const a = servicesWithHome("/home/a", homeA);
    const b = servicesWithHome("/home/b");
    register("source-a", a.services);
    register("source-b", b.services);

    const { result } = renderHook(() =>
      useSettingsScope({ workspacePath: "/work/a", initialScopeKey: "source-user:source-a" }),
    );
    expect(result.current.user).toEqual({ status: "connecting" });

    act(() => result.current.setSelectedScopeKey("source-user:source-b"));
    await waitFor(() =>
      expect(result.current.user).toMatchObject({
        status: "ready",
        target: { workspacePath: "/home/b" },
        cacheAuthorityKey: "source-settings:source-b",
      }),
    );

    await act(async () => {
      resolveHomeA("/home/a");
      await Promise.resolve();
    });
    // 迟到的 A home 只属于 A 的那组服务，不能覆盖当前 B 的目标。
    expect(result.current.user).toMatchObject({
      status: "ready",
      target: { workspacePath: "/home/b" },
    });
  });

  it("attachment 换代后旧 home 结果不落到新 attachment", async () => {
    state.targets = [remoteTarget("remote:server:source-a:/work/a")];
    state.inputs = new Map([["source-a", { state: "online", displayName: "Device A" }]]);
    let resolveOld!: (value: string) => void;
    const oldHome = new Promise<string>((resolve) => {
      resolveOld = resolve;
    });
    register("source-a", servicesWithHome("/home/old", oldHome).services);
    const { result } = renderHook(() =>
      useSettingsScope({ workspacePath: "/work/a", initialScopeKey: "source-user:source-a" }),
    );
    expect(result.current.user).toEqual({ status: "connecting" });

    // 同一 Source 注册新 attachment：旧服务上的 home 读取结果必须丢弃。
    await act(async () => {
      register("source-a", servicesWithHome("/home/new").services);
    });
    await waitFor(() =>
      expect(result.current.user).toMatchObject({
        status: "ready",
        target: { workspacePath: "/home/new" },
      }),
    );
    await act(async () => {
      resolveOld("/home/old");
      await Promise.resolve();
    });
    expect(result.current.user).toMatchObject({ target: { workspacePath: "/home/new" } });
  });

  it("显式项目尚未解析时保持加载态，目录加载完成后才回退到同设备「用户」", async () => {
    state.targets = [remoteTarget("remote:server:source-a:/work/a")];
    state.inputs = new Map([["source-a", { state: "online", displayName: "Device A" }]]);
    register("source-a", servicesWithHome("/home/a").services);
    const onFallback = vi.fn();

    const { result, rerender } = renderHook(() =>
      useSettingsScope({
        workspacePath: "/work/gone",
        initialScopeKey: "remote:server:source-a:/work/gone",
        onFallback,
      }),
    );
    // 目录未读取完成：不改写选择，也不用「用户」配置顶替待解析项目。
    expect(result.current.resolution).toMatchObject({ status: "missing" });
    expect(onFallback).not.toHaveBeenCalled();

    await act(async () => {
      state.loaded = true;
      state.targets = [remoteTarget("remote:server:source-a:/work/a")];
      rerender();
    });
    await waitFor(() => expect(onFallback).toHaveBeenCalledTimes(1));
    expect(result.current.selectedScopeKey).toBe("source-user:source-a");
    expect(result.current.resolution).toMatchObject({ status: "ready", kind: "user" });
  });

  it("项目 key 与「用户」在设备内互转，插件商店只在当前 workspace 设备上可用", () => {
    state.targets = [
      localTarget("/repo"),
      remoteTarget("remote:server:source-a:/work/a"),
      remoteTarget("remote:server:source-b:/work/b"),
    ];
    state.inputs = new Map([
      ["source-a", { state: "online", displayName: "Device A" }],
      ["source-b", { state: "online", displayName: "Device B" }],
    ]);
    register("source-a", servicesWithHome("/home/a").services);
    const { result } = renderHook(() =>
      useSettingsScope({
        workspacePath: "/work/a",
        workspaceIdentity: "remote:server:source-a:/work/a",
      }),
    );
    expect(result.current.isActiveWorkspaceDevice).toBe(true);
    act(() => result.current.setSelectedScopeKey("source-user:source-b"));
    expect(result.current.isActiveWorkspaceDevice).toBe(false);
    expect(result.current.toLocalScopeKey("source-user:source-b")).toBe("user");
    expect(result.current.toPageScopeKey("user")).toBe("source-user:source-b");
    expect(result.current.toLocalScopeKey("remote:server:source-a:/work/a")).toBe(
      "remote:server:source-a:/work/a",
    );
  });
});
