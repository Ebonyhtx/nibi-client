// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserViewExportPageResult } from "@nibi/shared";
import {
  TID_BROWSER_EXPORT_PDF_ITEM,
  TID_BROWSER_EXPORT_PNG_ITEM,
  TID_BROWSER_OPEN_EXTERNAL_ITEM,
} from "@nibi/shared/test-ids";
import {
  buildBrowserExportFileName,
  canExportBrowserPage,
  exportBrowserPageToFile,
} from "@/browser-use/browserPageExport.js";
import { INITIAL_BROWSER_STATE } from "@/embeddedBrowserHelpers.js";

// Radix portal 在 jsdom 里依赖 pointer capture/popper；这里把菜单摊平成普通按钮，
// 仍然保留 disabled/onSelect 语义，直接验证导出项的禁用与顺序。
vi.mock("@/components/ui/dropdown-menu.js", async () => {
  const React = await import("react");
  type ChildrenProps = { children?: import("react").ReactNode };
  const Passthrough = ({ children }: ChildrenProps) => children;
  return {
    DropdownMenu: Passthrough,
    DropdownMenuTrigger: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuItem: ({
      children,
      disabled,
      onSelect,
      "data-testid": testId,
    }: ChildrenProps & {
      disabled?: boolean;
      onSelect?: () => void;
      "data-testid"?: string;
    }) =>
      React.createElement(
        "button",
        {
          type: "button",
          disabled,
          "data-testid": testId,
          onClick: onSelect,
        },
        children,
      ),
  };
});
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children?: import("react").ReactNode }) => children,
}));

import { BrowserToolbar } from "@/EmbeddedBrowserPaneParts.js";

afterEach(() => {
  cleanup();
});

function createPlatform(
  overrides: {
    exportPage?: (payload: unknown) => Promise<BrowserViewExportPageResult>;
    saveFile?: (payload: unknown) => Promise<{
      success: boolean;
      canceled?: boolean;
      error?: string;
      path?: string;
    }>;
  } = {},
) {
  return {
    browserViewExportPage:
      overrides.exportPage ??
      vi.fn(async () => ({ success: true, data: new Uint8Array([1, 2, 3]).buffer })),
    saveFile: overrides.saveFile ?? vi.fn(async () => ({ success: true, path: "/tmp/export.png" })),
  };
}

describe("browser page export", () => {
  it("只有格式能力、保存能力、ready 且非 loading/失败/挂起时允许导出", () => {
    const platform = createPlatform();
    const readyState = { ...INITIAL_BROWSER_STATE, isReady: true };
    expect(canExportBrowserPage({ platform, browserState: readyState })).toBe(true);

    expect(
      canExportBrowserPage({ platform: { saveFile: vi.fn() }, browserState: readyState }),
    ).toBe(false);
    expect(
      canExportBrowserPage({
        platform: { browserViewExportPage: vi.fn() },
        browserState: readyState,
      }),
    ).toBe(false);
    expect(
      canExportBrowserPage({
        platform,
        browserState: { ...readyState, isReady: false },
      }),
    ).toBe(false);
    expect(
      canExportBrowserPage({
        platform,
        browserState: { ...readyState, isLoading: true },
      }),
    ).toBe(false);
    expect(
      canExportBrowserPage({
        platform,
        browserState: {
          ...readyState,
          guestFailure: { exitCode: 1, reason: "crashed" },
        },
      }),
    ).toBe(false);
    expect(
      canExportBrowserPage({
        platform,
        browserState: readyState,
        isResidencyRestore: true,
      }),
    ).toBe(false);
    expect(
      canExportBrowserPage({
        platform,
        browserState: readyState,
        isResidencySuspended: true,
      }),
    ).toBe(false);
    expect(
      canExportBrowserPage({
        platform,
        browserState: readyState,
        isExporting: true,
      }),
    ).toBe(false);
  });

  it("文件名清洗 Windows 非法字符、结尾空格与点", () => {
    expect(
      buildBrowserExportFileName({
        title: 'A/B:C*D?E"F<G>H|I. ',
        url: "https://example.com/report",
        format: "png",
      }),
    ).toBe("A B C D E F G H I.png");
    expect(
      buildBrowserExportFileName({
        title: "Report\u0000\u001fName",
        url: "https://example.com/report",
        format: "png",
      }),
    ).toBe("Report Name.png");
    expect(
      buildBrowserExportFileName({
        title: "  report...  ",
        url: "https://example.com/report",
        format: "pdf",
      }),
    ).toBe("report.pdf");
    expect(
      buildBrowserExportFileName({
        title: "   ",
        url: "https://docs.example.com/path?q=1",
        format: "png",
      }),
    ).toBe("docs.example.com.png");
    expect(
      buildBrowserExportFileName({
        title: "///",
        url: "about:blank",
        format: "pdf",
      }),
    ).toBe("page.pdf");
  });

  it("导出成功后用清洗后的文件名调用 saveFile 并提示成功", async () => {
    const exportPage = vi.fn(async () => ({
      success: true,
      data: new Uint8Array([1, 2, 3]).buffer,
    }));
    const saveFile = vi.fn(async () => ({ success: true, path: "/tmp/report.pdf" }));
    const notify = vi.fn();

    const outcome = await exportBrowserPageToFile({
      key: "browser:tab-1",
      webContentsId: 42,
      format: "pdf",
      title: "Quarterly/Report",
      url: "https://example.com/report",
      platform: createPlatform({ exportPage, saveFile }),
      formatMessage: ({ id }) => id,
      notify,
    });

    expect(outcome).toBe("saved");
    expect(exportPage).toHaveBeenCalledWith({
      key: "browser:tab-1",
      webContentsId: 42,
      format: "pdf",
    });
    expect(saveFile).toHaveBeenCalledWith({
      data: expect.any(ArrayBuffer),
      suggestedName: "Quarterly Report.pdf",
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith("browser.export.success");
  });

  it("保存对话框取消时不报错也不提示失败", async () => {
    const notify = vi.fn();
    const outcome = await exportBrowserPageToFile({
      key: "browser:tab-1",
      webContentsId: 42,
      format: "png",
      title: "Report",
      url: "https://example.com",
      platform: createPlatform({
        saveFile: vi.fn(async () => ({ success: false, canceled: true })),
      }),
      formatMessage: ({ id }) => id,
      notify,
    });

    expect(outcome).toBe("canceled");
    expect(notify).not.toHaveBeenCalled();
  });

  it("main 返回失败时提示失败且不打开保存框", async () => {
    const saveFile = vi.fn(async () => ({ success: true }));
    const notify = vi.fn();
    const outcome = await exportBrowserPageToFile({
      key: "browser:tab-1",
      webContentsId: 42,
      format: "png",
      platform: createPlatform({
        exportPage: vi.fn(async () => ({ success: false, error: "tab_loading" })),
        saveFile,
      }),
      formatMessage: ({ id }) => id,
      notify,
    });

    expect(outcome).toBe("failed");
    expect(saveFile).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("browser.export.failed");
  });

  it("main 抛错或返回空字节时提示失败且不打开保存框", async () => {
    const saveFile = vi.fn(async () => ({ success: true }));
    const notify = vi.fn();

    await expect(
      exportBrowserPageToFile({
        key: "browser:tab-1",
        webContentsId: 42,
        format: "png",
        platform: createPlatform({
          exportPage: vi.fn(async () => {
            throw new Error("ipc failed");
          }),
          saveFile,
        }),
        formatMessage: ({ id }) => id,
        notify,
      }),
    ).resolves.toBe("failed");
    expect(notify).toHaveBeenCalledWith("browser.export.failed");

    notify.mockClear();
    await expect(
      exportBrowserPageToFile({
        key: "browser:tab-1",
        webContentsId: 42,
        format: "pdf",
        platform: createPlatform({
          exportPage: vi.fn(async () => ({
            success: true,
            data: new ArrayBuffer(0),
          })),
          saveFile,
        }),
        formatMessage: ({ id }) => id,
        notify,
      }),
    ).resolves.toBe("failed");
    expect(notify).toHaveBeenCalledWith("browser.export.failed");
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("saveFile 抛错或返回失败时提示失败", async () => {
    const notify = vi.fn();
    const failedSave = vi.fn(async () => ({ success: false, error: "write_failed" }));
    const outcome = await exportBrowserPageToFile({
      key: "browser:tab-1",
      webContentsId: 42,
      format: "png",
      platform: createPlatform({ saveFile: failedSave }),
      formatMessage: ({ id }) => id,
      notify,
    });
    expect(outcome).toBe("failed");
    expect(notify).toHaveBeenCalledWith("browser.export.failed");

    notify.mockClear();
    const thrown = await exportBrowserPageToFile({
      key: "browser:tab-1",
      webContentsId: 42,
      format: "png",
      platform: createPlatform({
        saveFile: vi.fn(async () => {
          throw new Error("disk full");
        }),
      }),
      formatMessage: ({ id }) => id,
      notify,
    });
    expect(thrown).toBe("failed");
    expect(notify).toHaveBeenCalledWith("browser.export.failed");
  });
});

describe("browser toolbar export menu", () => {
  function renderToolbar(canExport: boolean) {
    const handlers = {
      onExportPng: vi.fn(),
      onExportPdf: vi.fn(),
    };
    render(
      createElement(BrowserToolbar, {
        addressValue: "",
        browserState: {
          ...INITIAL_BROWSER_STATE,
          currentUrl: "https://example.com/report",
          isReady: true,
        },
        formatMessage: ({ id }: { id: string }) => id,
        onAddressChange: vi.fn(),
        onGoBack: vi.fn(),
        onGoForward: vi.fn(),
        onOpenExternal: vi.fn(),
        onOpenDevTools: vi.fn(),
        onExportPng: handlers.onExportPng,
        onExportPdf: handlers.onExportPdf,
        onPickElement: vi.fn(),
        onReload: vi.fn(),
        onToggleResponsiveMode: vi.fn(),
        onSubmit: vi.fn(),
        isElementPickerActive: false,
        isResponsiveMode: false,
        canExport,
      }),
    );
    return handlers;
  }

  it("导出项位于默认浏览器打开之前，由 canExport 统一禁用", () => {
    renderToolbar(false);

    const png = screen.getByTestId(TID_BROWSER_EXPORT_PNG_ITEM) as HTMLButtonElement;
    const pdf = screen.getByTestId(TID_BROWSER_EXPORT_PDF_ITEM) as HTMLButtonElement;
    expect(png.disabled).toBe(true);
    expect(pdf.disabled).toBe(true);
    expect((screen.getByTestId(TID_BROWSER_OPEN_EXTERNAL_ITEM) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(
      Array.from(document.querySelectorAll("[data-testid$='-item']")).map((element) =>
        element.getAttribute("data-testid"),
      ),
    ).toEqual([
      TID_BROWSER_EXPORT_PNG_ITEM,
      TID_BROWSER_EXPORT_PDF_ITEM,
      TID_BROWSER_OPEN_EXTERNAL_ITEM,
    ]);

    cleanup();
    const handlers = renderToolbar(true);
    fireEvent.click(screen.getByTestId(TID_BROWSER_EXPORT_PNG_ITEM));
    fireEvent.click(screen.getByTestId(TID_BROWSER_EXPORT_PDF_ITEM));
    expect(handlers.onExportPng).toHaveBeenCalledTimes(1);
    expect(handlers.onExportPdf).toHaveBeenCalledTimes(1);
  });
});
