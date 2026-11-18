// @vitest-environment jsdom
import { createElement } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmbeddedBrowserWebviewChannels } from "@nibi/shared";
import {
  TID_BROWSER_DESIGN_SAVE_STATUS,
  TID_BROWSER_DESIGN_STYLE_VALUE,
} from "@nibi/shared/test-ids";
import type { DesignSelectedElement } from "@nibi/design-runtime";
import type { IFileService } from "@nibi/services";
import { BrowserDesignInspector } from "@/browser-use/BrowserDesignInspector.js";
import {
  designSourcePathForBrowserUrl,
  isDesignSourcePageUrl,
} from "@/browser-use/browserDesign.js";
import {
  designSaveErrorMessageId,
  useBrowserDesignMode,
  type BrowserDesignModeController,
} from "@/browser-use/useBrowserDesignMode.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useNibiIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

const SOURCE =
  '<html><head><style>:root { --brand: #112233; }</style></head><body><p style="color: red">Hello</p></body></html>';

const SELECTION: DesignSelectedElement = {
  element: {
    pageUrl: "file:///workspace/index.html",
    pageTitle: "Demo",
    tagName: "p",
    selector: "p",
    text: "Hello",
    capturedAt: 1,
    attributes: {},
  },
  editable: {
    text: "Hello",
    color: "rgb(255, 0, 0)",
    background: "rgba(0, 0, 0, 0)",
    backgroundColor: null,
    fontSize: "16px",
    fontWeight: "400",
    textAlign: "left",
    borderRadius: "0px",
    padding: "0px 0px 0px 0px",
    opacity: "1",
  },
  kind: "text",
  source: {
    steps: [
      { tag: "body", index: 1, siblings: 2 },
      { tag: "p", index: 0, siblings: 1 },
    ],
    id: null,
    className: null,
  },
  size: { width: 100, height: 20 },
  styleAttribute: "color: red",
};

const PAGE_INFO = {
  pageUrl: "file:///workspace/index.html",
  pageTitle: "Demo",
  isDesignDocument: false,
  variants: [],
  activeVariant: null,
  slideCount: 0,
  currentSlide: 0,
  cssVariables: [{ name: "--brand", value: "#112233" }],
  stageBackdrop: false,
};

function createWebview() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const executeJavaScript = vi.fn((script: string) =>
    Promise.resolve(
      script.includes("attachShadow")
        ? { ok: true, result: PAGE_INFO }
        : { ok: true, result: null },
    ),
  );
  const webview = {
    executeJavaScript,
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.get(type)?.delete(listener);
    },
  } as unknown as ElectronWebviewTag;
  const emitDesignEvents = (events: unknown[]) => {
    for (const listener of listeners.get("ipc-message") ?? []) {
      listener({ channel: EmbeddedBrowserWebviewChannels.DesignEvents, args: [events] });
    }
  };
  return { emitDesignEvents, executeJavaScript, webview };
}

function createFileService(written: boolean) {
  const readDesignSourceFile = vi.fn(async () => ({ content: SOURCE }));
  const writeDesignSourceFile = vi.fn(async () => ({ written }));
  const service = {
    readDesignSourceFile,
    writeDesignSourceFile,
  } as unknown as IFileService;
  return { readDesignSourceFile, service, writeDesignSourceFile };
}

afterEach(() => {
  cleanup();
});

describe("browser design source mapping", () => {
  it("maps signed nibi-html preview URLs back to the local HTML file", () => {
    const signed = `nibi-html://${"a".repeat(64)}/${encodeURIComponent("file:///workspace/")}/index.html?x=1#top`;
    expect(designSourcePathForBrowserUrl(signed)).toBe("/workspace/index.html");
    expect(isDesignSourcePageUrl(signed)).toBe(true);
  });

  it("maps local file URLs and rejects non-HTML / remote pages", () => {
    expect(designSourcePathForBrowserUrl("file:///C:/work/page.htm")).toBe("C:/work/page.htm");
    expect(designSourcePathForBrowserUrl("file:///workspace/page.txt")).toBeNull();
    expect(designSourcePathForBrowserUrl("https://example.com/page.html")).toBeNull();
    expect(designSourcePathForBrowserUrl("file://server/share/page.html")).toBeNull();
    expect(designSourcePathForBrowserUrl("nibi-html://unsigned/page.html")).toBeNull();
  });
});

describe("useBrowserDesignMode", () => {
  it("writes a style change back to source and reinjects the source style", async () => {
    const { service, writeDesignSourceFile } = createFileService(true);
    const { emitDesignEvents, executeJavaScript, webview } = createWebview();
    const { result } = renderHook(() =>
      useBrowserDesignMode({
        currentUrl: "file:///workspace/index.html",
        enabled: true,
        fileService: service,
        webview,
        webviewGeneration: 0,
        workspacePath: "/workspace",
      }),
    );

    expect(result.current.available).toBe(true);
    act(() => result.current.toggle());
    await act(async () => undefined);
    act(() => emitDesignEvents([{ type: "selection-changed", selections: [SELECTION] }]));
    await waitFor(() => expect(result.current.primary).not.toBeNull());
    await waitFor(() => expect(result.current.writable).toBe(true));

    await act(async () => {
      await result.current.commitStyle("color", "blue");
    });

    expect(writeDesignSourceFile).toHaveBeenCalledWith({
      path: "/workspace/index.html",
      workspacePath: "/workspace",
      expectedContent: SOURCE,
      content:
        '<html><head><style>:root { --brand: #112233; }</style></head><body><p style="color: blue">Hello</p></body></html>',
    });
    expect(result.current.saveState).toEqual({ status: "saved" });
    const reinjected = executeJavaScript.mock.calls.some(([script]) =>
      String(script).includes('"type":"set-element-style"'),
    );
    expect(reinjected).toBe(true);
  });

  it("rewrites a :root variable and reinjects the accumulated preview values", async () => {
    const { service, writeDesignSourceFile } = createFileService(true);
    const { executeJavaScript, webview } = createWebview();
    const { result } = renderHook(() =>
      useBrowserDesignMode({
        currentUrl: "file:///workspace/index.html",
        enabled: true,
        fileService: service,
        webview,
        webviewGeneration: 0,
        workspacePath: "/workspace",
      }),
    );

    act(() => result.current.toggle());
    await act(async () => undefined);
    await act(async () => {
      await result.current.commitVariable("--brand", "#aabbcc");
    });

    expect(writeDesignSourceFile).toHaveBeenCalledWith({
      path: "/workspace/index.html",
      workspacePath: "/workspace",
      expectedContent: SOURCE,
      content:
        '<html><head><style>:root { --brand: #aabbcc; }</style></head><body><p style="color: red">Hello</p></body></html>',
    });
    expect(result.current.variablePreview).toEqual({ "--brand": "#aabbcc" });
    expect(result.current.saveState).toEqual({ status: "saved" });
    expect(
      executeJavaScript.mock.calls.some(([script]) =>
        String(script).includes('"type":"set-css-variables"'),
      ),
    ).toBe(true);
  });

  it("reports an expected-content mismatch and reverts the page preview", async () => {
    const { service } = createFileService(false);
    const { emitDesignEvents, executeJavaScript, webview } = createWebview();
    const { result } = renderHook(() =>
      useBrowserDesignMode({
        currentUrl: "file:///workspace/index.html",
        enabled: true,
        fileService: service,
        webview,
        webviewGeneration: 0,
        workspacePath: "/workspace",
      }),
    );

    act(() => result.current.toggle());
    await act(async () => undefined);
    act(() => emitDesignEvents([{ type: "selection-changed", selections: [SELECTION] }]));
    await waitFor(() => expect(result.current.writable).toBe(true));

    await act(async () => {
      await result.current.commitStyle("color", "blue");
    });

    expect(result.current.saveState).toEqual({
      status: "error",
      messageId: designSaveErrorMessageId("changed"),
    });
    const reverted = executeJavaScript.mock.calls.some(
      ([script]) =>
        String(script).includes('"type":"set-element-style"') &&
        String(script).includes('"style":"color: red"'),
    );
    expect(reverted).toBe(true);
  });

  it("does not enable design mode for remote pages or without a file service", () => {
    const { webview } = createWebview();
    const remote = renderHook(() =>
      useBrowserDesignMode({
        currentUrl: "https://example.com/",
        enabled: true,
        fileService: createFileService(true).service,
        webview,
        webviewGeneration: 0,
        workspacePath: "/workspace",
      }),
    );
    expect(remote.result.current.available).toBe(false);

    const noService = renderHook(() =>
      useBrowserDesignMode({
        currentUrl: "file:///workspace/index.html",
        enabled: true,
        fileService: undefined,
        webview,
        webviewGeneration: 0,
        workspacePath: "/workspace",
      }),
    );
    expect(noService.result.current.available).toBe(false);
  });
});

describe("BrowserDesignInspector", () => {
  it("shows the real save error instead of a success state", () => {
    const design = {
      available: true,
      active: true,
      canWriteSource: true,
      sourceFileName: "index.html",
      toggle: vi.fn(),
      deactivate: vi.fn(),
      pageInfo: PAGE_INFO,
      selections: [SELECTION],
      primary: SELECTION,
      writable: true,
      sourceUnreadable: false,
      textWritable: true,
      variablePreview: {},
      saveState: { status: "error", messageId: "browser.design.save.changed" },
      commitStyle: vi.fn(async () => undefined),
      commitText: vi.fn(async () => undefined),
      commitVariable: vi.fn(async () => undefined),
    } as unknown as BrowserDesignModeController;

    render(createElement(BrowserDesignInspector, { design }));

    const status = screen.getByTestId(TID_BROWSER_DESIGN_SAVE_STATUS);
    expect(status.getAttribute("data-state")).toBe("error");
    expect(status.textContent).toBe("browser.design.save.changed");

    fireEvent.change(screen.getByTestId(TID_BROWSER_DESIGN_STYLE_VALUE), {
      target: { value: "blue" },
    });
    fireEvent.blur(screen.getByTestId(TID_BROWSER_DESIGN_STYLE_VALUE));
    expect(design.commitStyle).toHaveBeenCalledWith("color", "blue");
  });
});
