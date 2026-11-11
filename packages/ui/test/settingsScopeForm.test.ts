// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfigWorkspaceTarget, SettingsScopeState } from "@/settings-scope/contract.js";
import { useSettingsScopeForm } from "@/settings-scope/index.js";

const remoteTarget = (identity: string): ConfigWorkspaceTarget => ({
  workspacePath: identity.slice(identity.lastIndexOf(":") + 1),
  workspaceIdentity: identity,
  label: "repo",
  remoteSessionId: "session-1",
});

afterEach(cleanup);

describe("useSettingsScopeForm", () => {
  const scopeState = (
    device: SettingsScopeState["device"],
    resolution: SettingsScopeState["resolution"],
  ) => ({ device, resolution }) as Pick<SettingsScopeState, "device" | "resolution">;

  it("打开表单后切到其他设备：渲染期清掉，不带到新设备", () => {
    const local = scopeState(
      { kind: "local" },
      { status: "ready", key: "user", kind: "user", device: { kind: "local" } },
    );
    const remoteB = scopeState(
      { kind: "remote", id: "source-b", sourceServerId: "source-b", name: "B" },
      {
        status: "ready",
        key: "source-user:source-b",
        kind: "user",
        device: { kind: "remote", id: "source-b", sourceServerId: "source-b", name: "B" },
      },
    );
    const { result, rerender } = renderHook(
      ({ scope }) => useSettingsScopeForm<{ id: string }>(scope),
      {
        initialProps: { scope: local },
      },
    );
    act(() => result.current.openForm({ id: "hook-1" }));
    expect(result.current.form).toEqual({ id: "hook-1" });

    rerender({ scope: remoteB });
    expect(result.current.form).toBeNull();
  });

  it("同一设备内切换「用户」/ 项目、项目回退帧都不关闭表单", () => {
    const remoteAUser = scopeState(
      { kind: "remote", id: "source-a", sourceServerId: "source-a", name: "A" },
      {
        status: "ready",
        key: "source-user:source-a",
        kind: "user",
        device: { kind: "remote", id: "source-a", sourceServerId: "source-a", name: "A" },
      },
    );
    const remoteAProject = scopeState(
      { kind: "remote", id: "source-a", sourceServerId: "source-a", name: "A" },
      {
        status: "ready",
        key: "remote:server:source-a:/work/a",
        kind: "workspace",
        device: { kind: "remote", id: "source-a", sourceServerId: "source-a", name: "A" },
        target: remoteTarget("remote:server:source-a:/work/a"),
      },
    );
    // 项目关闭先给出一帧 missing（device 暂记本机），按 fallbackKey 判断设备。
    const remoteAMissing = scopeState(
      { kind: "local" },
      {
        status: "missing",
        key: "remote:server:source-a:/gone",
        fallbackKey: "source-user:source-a",
      },
    );
    const { result, rerender } = renderHook(
      ({ scope }) => useSettingsScopeForm<{ id: string }>(scope),
      {
        initialProps: { scope: remoteAUser },
      },
    );
    act(() => result.current.openForm({ id: "hook-1" }));

    rerender({ scope: remoteAProject });
    expect(result.current.form).toEqual({ id: "hook-1" });
    rerender({ scope: remoteAMissing });
    expect(result.current.form).toEqual({ id: "hook-1" });
    rerender({ scope: remoteAUser });
    expect(result.current.form).toEqual({ id: "hook-1" });
  });

  it("设备离线时表单隐藏但保留，恢复后仍属于原设备", () => {
    const ready = scopeState(
      { kind: "remote", id: "source-a", sourceServerId: "source-a", name: "A" },
      {
        status: "ready",
        key: "source-user:source-a",
        kind: "user",
        device: { kind: "remote", id: "source-a", sourceServerId: "source-a", name: "A" },
      },
    );
    const offline = scopeState(
      { kind: "remote", id: "source-a", sourceServerId: "source-a", name: "A" },
      {
        status: "offline",
        key: "source-user:source-a",
        device: { kind: "remote", id: "source-a", sourceServerId: "source-a", name: "A" },
      },
    );
    const { result, rerender } = renderHook(
      ({ scope }) => useSettingsScopeForm<{ id: string }>(scope),
      {
        initialProps: { scope: ready },
      },
    );
    act(() => result.current.openForm({ id: "hook-1" }));
    rerender({ scope: offline });
    // 页面用 resolveSettingsScopeBlock 隐藏表单；hook 本身保留状态，恢复后仍可见。
    expect(result.current.form).toEqual({ id: "hook-1" });
    rerender({ scope: ready });
    expect(result.current.form).toEqual({ id: "hook-1" });
  });
});
