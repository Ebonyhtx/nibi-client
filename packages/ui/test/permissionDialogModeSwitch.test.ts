// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NibiPermissionRequest } from "@nibi/shared";
import type { ConversationSnapshot } from "@nibi/shared/nibi-protocol-v4";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";
import { PermissionDialog } from "@/PermissionDialog.js";
import { V4InteractionDialogs } from "@/v4/V4InteractionDialogs.js";

vi.mock("@/v4/V4ConversationContext.js", () => ({
  useV4Conversation: () => ({ sendCommand: vi.fn() }),
}));

function installAnimationFrameController() {
  let nextFrameId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      callbacks.set(frameId, callback);
      return frameId;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn((frameId: number) => callbacks.delete(frameId)));
  return {
    flush() {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback(performance.now());
    },
  };
}

const baseOptions = [
  {
    optionId: "allowOnce",
    kind: "allowOnce" as const,
    name: "Allow once",
    response: { decision: "allow" as const },
  },
  {
    optionId: "allowAlways",
    kind: "allowAlways" as const,
    name: "Always allow in this project",
    response: { decision: "allow" as const },
  },
  {
    optionId: "fullAccess",
    kind: "custom" as const,
    name: "Full access",
    response: { decision: "deny" as const },
  },
  {
    optionId: "deny",
    kind: "deny" as const,
    name: "Deny",
    response: { decision: "deny" as const },
  },
];

const request: NibiPermissionRequest = {
  type: "permission_request",
  taskId: "task-mode",
  traceId: "trace-mode",
  requestId: "request-mode",
  description: "Run rm -rf build",
  kind: "Bash",
  freeText: true,
  options: baseOptions,
  raw: { command: "rm -rf build" },
};

function renderDialog(
  props: {
    permissionMode?: string;
    modeSwitch?: "choose" | "fullAccessOnly";
  },
  onRespond = vi.fn(),
) {
  const animationFrame = installAnimationFrameController();
  render(
    createElement(
      NibiIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(PermissionDialog, {
        request,
        onRespond,
        workspacePath: "/tmp/workspace",
        ...props,
      }),
    ),
  );
  animationFrame.flush();
  return { onRespond };
}

function switchButton() {
  return screen.getByTestId("permission-allow-switch");
}

function confirmFullAccessSwitch() {
  fireEvent.click(screen.getByRole("checkbox", { name: /我已了解风险/ }));
  fireEvent.click(screen.getByRole("button", { name: "确认启用" }));
}

describe("PermissionDialog mode switching", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("offers the guarded/yolo picker and allows once with the guarded option id", () => {
    const { onRespond } = renderDialog({ permissionMode: "build", modeSwitch: "choose" });

    expect(screen.getByTestId("permission-target-picker").textContent).toContain("自主模式");
    expect(switchButton().getAttribute("aria-label")).toBe("允许并切换到 自主模式");

    fireEvent.click(switchButton());

    // 切到 guarded 是收窄权限，不需要二次确认；内核据 allowAndSwitchGuarded 先 SetMode。
    expect(onRespond).toHaveBeenCalledExactlyOnceWith(
      "request-mode",
      expect.objectContaining({ optionId: "allowAndSwitchGuarded" }),
      undefined,
    );
  });

  it("asks before switching to yolo and only then submits fullAccess", async () => {
    const { onRespond } = renderDialog({ permissionMode: "build", modeSwitch: "choose" });

    fireEvent.pointerDown(screen.getByTestId("permission-target-picker"), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByTestId("permission-target-yolo"));
    expect(switchButton().getAttribute("aria-label")).toBe("允许并切换到 完全访问");

    fireEvent.click(switchButton());
    expect(await screen.findByRole("dialog")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "要启用完全访问吗？" })).not.toBeNull();
    expect(onRespond).not.toHaveBeenCalled();

    confirmFullAccessSwitch();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onRespond).toHaveBeenCalledExactlyOnceWith(
      "request-mode",
      expect.objectContaining({ optionId: "fullAccess" }),
      undefined,
    );
  });

  it("treats fullAccessOnly as a fixed full-access switch with the same confirmation", async () => {
    const { onRespond } = renderDialog({
      permissionMode: "guarded",
      modeSwitch: "fullAccessOnly",
    });

    expect(screen.queryByTestId("permission-target-picker")).toBeNull();
    expect(switchButton().getAttribute("aria-label")).toBe("允许并切换到 完全访问");

    fireEvent.click(switchButton());
    expect(await screen.findByRole("dialog")).not.toBeNull();
    expect(onRespond).not.toHaveBeenCalled();

    confirmFullAccessSwitch();
    await waitFor(() => expect(onRespond).toHaveBeenCalledOnce());
    expect(onRespond).toHaveBeenCalledWith(
      "request-mode",
      expect.objectContaining({ optionId: "fullAccess" }),
      undefined,
    );
  });

  it("keeps the legacy single-grant full-access option when the snapshot has no modeSwitch", () => {
    const { onRespond } = renderDialog({ permissionMode: "build" });

    expect(screen.queryByTestId("permission-target-picker")).toBeNull();
    expect(screen.queryByTestId("permission-allow-switch")).toBeNull();

    const fullAccess = screen
      .getAllByRole("option")
      .find((option) => option.getAttribute("aria-label") === "完全访问");
    expect(fullAccess).toBeDefined();
    // 先聚焦选中，再点一次提交（与其他选项的键盘/点击语义一致）。
    fireEvent.click(fullAccess!);
    fireEvent.click(fullAccess!);
    expect(onRespond).toHaveBeenCalledWith(
      "request-mode",
      expect.objectContaining({ optionId: "fullAccess" }),
      undefined,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("passes the snapshot mode and payload modeSwitch through V4InteractionDialogs", () => {
    const snapshot = {
      sessionId: "sess-mode",
      config: {
        mode: "build",
        provider: "nibi-agent",
        model: "m",
        modelSelection: { providerId: "nibi-agent", modelId: "m" },
      },
      pendingInteractions: [
        {
          interactionId: "perm-mode",
          kind: "permission",
          anchorRowId: null,
          createdAt: 1,
          payload: {
            kind: "permission",
            toolCallId: "tool-mode",
            toolName: "Bash",
            summary: "Run rm -rf build",
            detail: { command: "rm -rf build" },
            freeText: true,
            modeSwitch: "choose",
            fullAccessOption: {
              optionId: "fullAccess",
              label: "Full access",
              kind: "custom",
              response: { decision: "deny" },
            },
            options: [
              { optionId: "allowOnce", label: "Allow once", kind: "allowOnce" },
              { optionId: "deny", label: "Deny", kind: "deny" },
            ],
          },
        },
      ],
    } as unknown as ConversationSnapshot;

    render(
      createElement(
        NibiIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(V4InteractionDialogs, {
          sessionId: "sess-mode",
          workspacePath: "/workspace",
          snapshot,
        }),
      ),
    );

    expect(screen.getByTestId("permission-target-picker")).not.toBeNull();
    expect(screen.getByTestId("permission-allow-switch").textContent).toContain("允许并切换到");
    expect(screen.getByTestId("permission-target-picker").textContent).toContain("自主模式");
  });
});
