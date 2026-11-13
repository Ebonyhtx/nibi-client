// @vitest-environment jsdom
import { createElement, useCallback, useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";
import { useFullAccessModeConfirmation } from "@/v4/FullAccessModeConfirmDialog.js";

afterEach(cleanup);

const HIGH_PERMISSION_MODES = ["yolo", "full-access", "agent-full-access"] as const;
const ALL_MODES = ["build", "guarded", "plan", ...HIGH_PERMISSION_MODES];

function Harness({
  initialMode,
  handleDraftSwitchMode,
}: {
  initialMode: string;
  handleDraftSwitchMode: (mode: string) => void;
}): ReactNode {
  const [mode, setMode] = useState(initialMode);
  const applyModeSwitch = useCallback(
    (nextMode: string) => {
      setMode(nextMode);
      handleDraftSwitchMode(nextMode);
    },
    [handleDraftSwitchMode],
  );
  const { requestModeSwitch, confirmDialog } = useFullAccessModeConfirmation({
    currentMode: mode,
    onApplyModeSwitch: applyModeSwitch,
  });
  return createElement(
    "div",
    null,
    createElement("output", { "data-testid": "current-mode" }, mode),
    ...ALL_MODES.map((candidate) =>
      createElement(
        "button",
        {
          key: candidate,
          type: "button",
          onClick: () => requestModeSwitch(candidate),
        },
        candidate,
      ),
    ),
    confirmDialog,
  );
}

function renderHarness(initialMode: string, locale: "zh-CN" | "en-US" = "zh-CN") {
  const handleDraftSwitchMode = vi.fn();
  render(
    createElement(
      NibiIntlProvider,
      { initialLocale: locale },
      createElement(Harness, { initialMode, handleDraftSwitchMode }),
    ),
  );
  return { handleDraftSwitchMode };
}

function requestMode(mode: string) {
  fireEvent.click(screen.getByRole("button", { name: mode }));
}

function currentModeText() {
  return screen.getByTestId("current-mode").textContent;
}

function checkbox() {
  return screen.getByRole("checkbox", { name: /我已了解风险/ });
}

function confirmButton() {
  return screen.getByRole("button", { name: "确认启用" });
}

describe("full access mode confirmation", () => {
  it.each(HIGH_PERMISSION_MODES)(
    "asks before switching to high-permission mode %s without changing the draft",
    async (mode) => {
      const { handleDraftSwitchMode } = renderHarness("build");

      requestMode(mode);

      expect(await screen.findByRole("dialog")).not.toBeNull();
      expect(screen.getByRole("heading", { name: "要启用完全访问吗？" })).not.toBeNull();
      // 弹窗打开只挂起目标值：取消前不得写入草稿，也不得调用原切换入口。
      expect(currentModeText()).toBe("build");
      expect(handleDraftSwitchMode).not.toHaveBeenCalled();
    },
  );

  it("applies normal modes immediately and never asks when leaving full access", () => {
    const normal = renderHarness("build");
    requestMode("guarded");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(normal.handleDraftSwitchMode).toHaveBeenLastCalledWith("guarded");
    expect(currentModeText()).toBe("guarded");
    cleanup();

    const leaving = renderHarness("yolo");
    requestMode("build");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(leaving.handleDraftSwitchMode).toHaveBeenLastCalledWith("build");
    expect(currentModeText()).toBe("build");
  });

  it("does not ask again when the user reselects the current full-access mode", () => {
    const { handleDraftSwitchMode } = renderHarness("yolo");

    requestMode("yolo");

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(handleDraftSwitchMode).toHaveBeenCalledExactlyOnceWith("yolo");
    expect(currentModeText()).toBe("yolo");
  });

  it("keeps the original mode when the confirmation is cancelled", async () => {
    const { handleDraftSwitchMode } = renderHarness("build");
    requestMode("yolo");
    expect(await screen.findByRole("dialog")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(currentModeText()).toBe("build");
    expect(handleDraftSwitchMode).not.toHaveBeenCalled();
  });

  it("requires the acknowledgement before enabling the destructive button", async () => {
    const { handleDraftSwitchMode } = renderHarness("build");
    requestMode("agent-full-access");
    expect(await screen.findByRole("dialog")).not.toBeNull();

    const confirm = confirmButton() as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(handleDraftSwitchMode).not.toHaveBeenCalled();

    fireEvent.click(checkbox());
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(handleDraftSwitchMode).toHaveBeenCalledExactlyOnceWith("agent-full-access");
    expect(currentModeText()).toBe("agent-full-access");
  });

  it("moves focus inside the dialog and gives the checkbox an accessible name", async () => {
    renderHarness("build");
    requestMode("yolo");
    expect(await screen.findByRole("dialog")).not.toBeNull();

    await waitFor(() => expect(document.activeElement).toBe(checkbox()));
    expect(checkbox().getAttribute("aria-labelledby")).toBeTruthy();
  });

  it("renders every risk capability in English when the locale is en-US", async () => {
    renderHarness("build", "en-US");
    requestMode("yolo");

    expect(await screen.findByRole("heading", { name: "Enable full access?" })).not.toBeNull();
    expect(screen.getByText("Files and folders")).not.toBeNull();
    expect(screen.getByText("Terminal commands")).not.toBeNull();
    expect(screen.getByText("Network and apps")).not.toBeNull();
    expect(screen.getByRole("checkbox", { name: /I understand the risks/ })).not.toBeNull();
  });
});
