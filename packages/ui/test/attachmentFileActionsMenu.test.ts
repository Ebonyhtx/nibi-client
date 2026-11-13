// @vitest-environment jsdom

import { createElement, type ComponentProps, type ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPlatformService, SaveFileRequest } from "@nibi/shared";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";
import { AttachmentFileActionsMenu } from "@/v4/AttachmentFileActionsMenu.js";

// Radix 菜单在关闭态不渲染内容，且 jsdom 里没有完整 pointer capture；
// 这里把菜单原语替换为直出结构，点击菜单项直接触发 onSelect，只验证本组件的行为。
vi.mock("@/components/ui/dropdown-menu.js", async () => {
  const React = await import("react");
  return {
    DropdownMenu: ({ children }: { children?: ReactNode }) =>
      React.createElement("div", null, children),
    DropdownMenuTrigger: ({ children }: { children?: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    DropdownMenuContent: ({ children }: { children?: ReactNode }) =>
      React.createElement("div", { role: "menu" }, children),
    DropdownMenuItem: ({
      children,
      onSelect,
      ...props
    }: {
      children?: ReactNode;
      onSelect?: () => void;
    } & Record<string, unknown>) =>
      React.createElement(
        "button",
        { ...props, type: "button", onClick: () => onSelect?.() },
        children,
      ),
  };
});

vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

function createPlatform(overrides: Partial<IPlatformService> = {}): IPlatformService {
  return {
    canOpenLocalFiles: true,
    openExternalFile: vi.fn(async () => ({ success: true })),
    openInFileManager: vi.fn(async () => ({ success: true })),
    saveFile: vi.fn(async (_payload: SaveFileRequest) => ({ success: true, path: "saved" })),
    ...overrides,
  } as unknown as IPlatformService;
}

function renderMenu(
  platform: IPlatformService,
  props: Partial<ComponentProps<typeof AttachmentFileActionsMenu>> = {},
) {
  return render(
    createElement(
      NibiIntlProvider,
      { initialLocale: "en-US" },
      createElement(
        PlatformProvider,
        { platform },
        createElement(AttachmentFileActionsMenu, { fileName: "report.pdf", ...props }),
      ),
    ),
  );
}

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("AttachmentFileActionsMenu", () => {
  it("renders the file actions and calls the matching platform capability", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const platform = createPlatform();
    renderMenu(platform, {
      localPath: "C:\\work\\docs\\report.pdf",
      readBytes: async () => new Uint8Array([1, 2, 3]),
    });

    const trigger = screen.getByTestId("chat-attachment-file-actions-trigger");
    expect(trigger.getAttribute("aria-label")).toBe("File actions");
    expect(screen.getByTestId("chat-attachment-file-actions-open")).toBeTruthy();
    expect(screen.getByTestId("chat-attachment-file-actions-reveal")).toBeTruthy();
    expect(screen.getByTestId("chat-attachment-file-actions-save-as")).toBeTruthy();
    expect(screen.getByTestId("chat-attachment-file-actions-copy-path")).toBeTruthy();

    fireEvent.click(screen.getByTestId("chat-attachment-file-actions-open"));
    await waitFor(() =>
      expect(platform.openExternalFile).toHaveBeenCalledWith("C:\\work\\docs\\report.pdf"),
    );

    // 定位动作沿用 useFileContextActions 的既有语义：文件交给系统前先取所在目录。
    fireEvent.click(screen.getByTestId("chat-attachment-file-actions-reveal"));
    await waitFor(() => expect(platform.openInFileManager).toHaveBeenCalledWith("C:\\work\\docs"));

    fireEvent.click(screen.getByTestId("chat-attachment-file-actions-copy-path"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("C:\\work\\docs\\report.pdf"));

    fireEvent.click(screen.getByTestId("chat-attachment-file-actions-save-as"));
    await waitFor(() => expect(platform.saveFile).toHaveBeenCalledTimes(1));
    const savePayload = (platform.saveFile as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as SaveFileRequest;
    expect(savePayload.suggestedName).toBe("report.pdf");
    expect(savePayload.data).toBeInstanceOf(ArrayBuffer);
    expect(savePayload.data.byteLength).toBe(3);
  });

  it("keeps only Save As for attachments without a local path", () => {
    const platform = createPlatform();
    renderMenu(platform, { readBytes: async () => new Uint8Array([1]) });

    expect(screen.getByTestId("chat-attachment-file-actions-save-as")).toBeTruthy();
    expect(screen.queryByTestId("chat-attachment-file-actions-open")).toBeNull();
    expect(screen.queryByTestId("chat-attachment-file-actions-reveal")).toBeNull();
    expect(screen.queryByTestId("chat-attachment-file-actions-copy-path")).toBeNull();
  });

  it("does not offer path actions for a remote workspace path", () => {
    const platform = createPlatform();
    renderMenu(platform, {
      localPath: "C:\\remote-host-only\\report.pdf",
      localPathActionsEnabled: false,
      readBytes: async () => new Uint8Array([1]),
    });

    expect(screen.getByTestId("chat-attachment-file-actions-save-as")).toBeTruthy();
    expect(screen.queryByTestId("chat-attachment-file-actions-open")).toBeNull();
    expect(screen.queryByTestId("chat-attachment-file-actions-reveal")).toBeNull();
    expect(screen.queryByTestId("chat-attachment-file-actions-copy-path")).toBeNull();
  });

  it("renders nothing on Web hosts without local file capabilities", () => {
    const platform = createPlatform({
      canOpenLocalFiles: false,
      openExternalFile: undefined,
      saveFile: undefined,
    });
    renderMenu(platform, {
      localPath: "/home/user/report.pdf",
      readBytes: async () => new Uint8Array([1]),
    });

    expect(screen.queryByTestId("chat-attachment-file-actions-trigger")).toBeNull();
  });
});
