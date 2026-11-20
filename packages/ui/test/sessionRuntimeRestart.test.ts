// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSessionRuntimeRestart } from "@/app-shell/useWorkspaceSessionReload.js";

const mocks = vi.hoisted(() => ({
  restartSessionRuntime: vi.fn(),
  toast: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServices: () => ({
    nibiAgentService: { restartSessionRuntime: mocks.restartSessionRuntime },
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useNibiIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

vi.mock("@/components/ui/toast.js", () => ({ toast: mocks.toast }));

vi.mock("@/logger.js", () => ({
  logger: { info: vi.fn(), warn: mocks.loggerWarn },
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("useSessionRuntimeRestart", () => {
  it("restarts the target session through the agent runtime RPC", async () => {
    mocks.restartSessionRuntime.mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useSessionRuntimeRestart("/workspace", "session-a", null, undefined),
    );

    let outcome = false;
    await act(async () => {
      outcome = await result.current.restart();
    });

    expect(outcome).toBe(true);
    expect(mocks.restartSessionRuntime).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      sessionId: "session-a",
    });
    expect(result.current.pending).toBe(false);
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("does not call the runtime without a session", async () => {
    const { result } = renderHook(() =>
      useSessionRuntimeRestart("/workspace", null, null, undefined),
    );

    let outcome = true;
    await act(async () => {
      outcome = await result.current.restart();
    });

    expect(outcome).toBe(false);
    expect(mocks.restartSessionRuntime).not.toHaveBeenCalled();
  });

  it("reports unsupported runtimes with the dedicated message", async () => {
    mocks.restartSessionRuntime.mockRejectedValue(
      new Error("fault.sessionLifecycle.unsupported"),
    );
    const { result } = renderHook(() =>
      useSessionRuntimeRestart("/workspace", "session-a", null, "remote:ssh:host:/workspace"),
    );

    let outcome = true;
    await act(async () => {
      outcome = await result.current.restart();
    });

    expect(outcome).toBe(false);
    expect(mocks.restartSessionRuntime).toHaveBeenCalledWith({
      workspacePath: "/workspace",
      sessionId: "session-a",
      workspaceIdentity: "remote:ssh:host:/workspace",
    });
    expect(mocks.toast).toHaveBeenCalledWith("taskList.restartUnsupported");
  });

  it("reports other failures with the retryable message", async () => {
    mocks.restartSessionRuntime.mockRejectedValue(new Error("transport closed"));
    const { result } = renderHook(() =>
      useSessionRuntimeRestart("/workspace", "session-a", null, undefined),
    );

    await act(async () => {
      await result.current.restart();
    });

    expect(mocks.toast).toHaveBeenCalledWith("taskList.restartFailed");
    expect(mocks.loggerWarn).toHaveBeenCalled();
  });
});
