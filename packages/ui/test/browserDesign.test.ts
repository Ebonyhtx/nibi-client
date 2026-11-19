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
import type { DesignPageInfo, DesignSelectedElement } from "@nibi/design-runtime";
import type { IFileService } from "@nibi/services";
import { BrowserDesignInspector } from "@/browser-use/BrowserDesignInspector.js";
import {
  designSourcePathForBrowserUrl,
  isDesignSourcePageUrl,
} from "@/browser-use/browserDesign.js";
import { DESIGN_PLUGIN_ID, resolveDesignPluginGateStatus } from "@/browser-use/useBrowserDesignPluginGate.js";
import {
  WEB_ELEMENT_CONTEXT_ADD_TO_CHAT_EVENT,
  WEB_ELEMENT_CONTEXT_REMOVE_FROM_CHAT_EVENT,
} from "@/lib/webElementContext.js";
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

const PAGE_INFO: DesignPageInfo = {
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

const DESIGN_PAGE_INFO = {
  ...PAGE_INFO,
  isDesignDocument: true,
  variants: ["alpha", "beta"],
  slideCount: 3,
  currentSlide: 0,
};

function createWebview(options: { info?: typeof PAGE_INFO } = {}) {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const executeJavaScript = vi.fn((script: string) =>
    Promise.resolve(
      script.includes("attachShadow")
        ? { ok: true, result: options.info ?? PAGE_INFO }
        : { ok: true, result: null },
    ),
  );
  const webview = {
    executeJavaScript,
    getURL: () => (options.info ?? PAGE_INFO).pageUrl,
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
  const emitDomReady = () => {
    for (const listener of listeners.get("dom-ready") ?? []) listener({});
  };
  const commands = () =>
    executeJavaScript.mock.calls
      .map(([script]) => String(script))
      .filter((script) => script.includes("__nibiDesignRuntime"));
  return { commands, emitDesignEvents, emitDomReady, executeJavaScript, webview };
}

function createFileService(written: boolean, initialContent = SOURCE) {
  let content = initialContent;
  const readDesignSourceFile = vi.fn(async () => ({ content }));
  const writeDesignSourceFile = vi.fn(async (params: { content: string }) => {
    if (!written) return { written: false };
    content = params.content;
    return { written: true };
  });
  const service = {
    readDesignSourceFile,
    writeDesignSourceFile,
  } as unknown as IFileService;
  return {
    readDesignSourceFile,
    service,
    setContent: (next: string) => {
      content = next;
    },
    writeDesignSourceFile,
  };
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

  it("keeps the selected variant and pinned selectors across a document reinjection", async () => {
    const { service } = createFileService(true);
    const { commands, emitDesignEvents, emitDomReady, webview } = createWebview({
      info: DESIGN_PAGE_INFO,
    });
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
    act(() => result.current.setVariant("beta"));
    act(() => emitDesignEvents([{ type: "selection-changed", selections: [SELECTION] }]));
    await waitFor(() => expect(result.current.primary?.element.selector).toBe("p"));

    // 刷新 / 自动重载：同一页面重新注入运行时，宿主把方案与选中（pins）重新推回去。
    act(() => emitDomReady());
    await waitFor(() =>
      expect(commands().some((script) => script.includes('"type":"set-variant","variant":"beta"'))).toBe(
        true,
      ),
    );
    expect(
      commands().some(
        (script) => script.includes('"type":"set-selection","selectors":["p"]'),
      ),
    ).toBe(true);
    expect(result.current.variant).toBe("beta");
    expect(result.current.slide).toEqual({ index: 0, count: 3 });
  });

  it("undoes and redoes a source write, and refuses when the file changed", async () => {
    const file = createFileService(true);
    const { emitDesignEvents, webview } = createWebview();
    const { result } = renderHook(() =>
      useBrowserDesignMode({
        currentUrl: "file:///workspace/index.html",
        enabled: true,
        fileService: file.service,
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
    expect(file.writeDesignSourceFile).toHaveBeenCalledTimes(1);
    // 自动刷新：这次主 HTML 变化是本 tab 写的，不应 reload 丢掉选中和滚动位置。
    await expect(result.current.isOwnSourceWrite("/workspace/index.html")).resolves.toBe(true);

    await act(async () => {
      await result.current.undo();
    });
    expect(file.writeDesignSourceFile).toHaveBeenCalledTimes(2);
    expect(file.writeDesignSourceFile.mock.calls[1]?.[0]).toMatchObject({ content: SOURCE });
    expect(result.current.saveState).toEqual({ status: "saved" });

    await act(async () => {
      await result.current.redo();
    });
    expect(file.writeDesignSourceFile).toHaveBeenCalledTimes(3);
    expect(file.writeDesignSourceFile.mock.calls[2]?.[0]).toMatchObject({
      content: SOURCE.replace('style="color: red"', 'style="color: blue"'),
    });

    // 外部改动后撤销：不覆盖别人的改动，撤销栈清空并提示 changed。
    file.setContent(SOURCE.replace("Hello", "External edit"));
    await act(async () => {
      await result.current.undo();
    });
    expect(result.current.saveState).toEqual({
      status: "error",
      messageId: designSaveErrorMessageId("changed"),
    });
  });

  it("adds selected elements to the composer as chips and removes them when deselected", async () => {
    const { service } = createFileService(true);
    const { emitDesignEvents, webview } = createWebview();
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const onAdd = (event: Event) => {
      // 模拟 composer：收下引用时 preventDefault，宿主据此认为 chip 已进输入框。
      event.preventDefault();
      added.push((event as CustomEvent<unknown>).detail);
    };
    const onRemove = (event: Event) => removed.push((event as CustomEvent<unknown>).detail);
    window.addEventListener(WEB_ELEMENT_CONTEXT_ADD_TO_CHAT_EVENT, onAdd);
    window.addEventListener(WEB_ELEMENT_CONTEXT_REMOVE_FROM_CHAT_EVENT, onRemove);
    try {
      const { result } = renderHook(() =>
        useBrowserDesignMode({
          currentUrl: "file:///workspace/index.html",
          chipTarget: { workspacePath: "/workspace" },
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
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({ selector: "p", workspacePath: "/workspace" });

      act(() => emitDesignEvents([{ type: "selection-changed", selections: [] }]));
      expect(removed).toHaveLength(1);
      expect(removed[0]).toMatchObject({ workspacePath: "/workspace" });
    } finally {
      window.removeEventListener(WEB_ELEMENT_CONTEXT_ADD_TO_CHAT_EVENT, onAdd);
      window.removeEventListener(WEB_ELEMENT_CONTEXT_REMOVE_FROM_CHAT_EVENT, onRemove);
    }
  });

  it("captures the primary selection by hiding overlays, then ends capture", async () => {
    const { service } = createFileService(true);
    const captureElement = vi.fn(async () => new Uint8Array([1, 2, 3]).buffer);
    const { commands, emitDesignEvents, executeJavaScript, webview } = createWebview();
    const { result } = renderHook(() =>
      useBrowserDesignMode({
        captureElement,
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
    executeJavaScript.mockImplementation((script: string) =>
      Promise.resolve(
        script.includes('"type":"locate-for-capture"')
          ? { ok: true, result: { x: 1, y: 2, width: 10, height: 20 } }
          : { ok: true, result: null },
      ),
    );

    let data: ArrayBuffer | null = null;
    await act(async () => {
      data = await result.current.captureSelection();
    });

    expect(captureElement).toHaveBeenCalledWith({ x: 1, y: 2, width: 10, height: 20 });
    expect(data).not.toBeNull();
    expect(commands().some((script) => script.includes('"type":"end-capture"'))).toBe(true);
  });

  it("only exposes design selection on local HTML that can be written back", () => {
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
    // 设计桥只接受本地预览页；普通网页继续走原有元素选择器。
    expect(remote.result.current.available).toBe(false);
    expect(remote.result.current.canWriteSource).toBe(false);

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
    expect(noService.result.current.canWriteSource).toBe(false);
  });

  it("拒绝插件未启用时的点选，运行时不会注入", async () => {
    const { webview } = createWebview();
    const requestPluginEnable = vi.fn(async () => false);
    const { result } = renderHook(() =>
      useBrowserDesignMode({
        currentUrl: "file:///workspace/index.html",
        enabled: true,
        fileService: createFileService(true).service,
        pluginEnabled: false,
        requestPluginEnable,
        webview,
        webviewGeneration: 0,
        workspacePath: "/workspace",
      }),
    );

    await act(async () => {
      await result.current.requestSelectMode();
    });

    expect(requestPluginEnable).toHaveBeenCalledTimes(1);
    expect(result.current.mode).toBe("off");
    expect(result.current.active).toBe(false);
  });
});

describe("design plugin gate", () => {
  const plugin = (enabled: boolean) => ({ id: DESIGN_PLUGIN_ID, enabled });

  it("maps plugin list, loading and errors to the gate", () => {
    expect(
      resolveDesignPluginGateStatus({
        error: null,
        loading: false,
        plugins: [plugin(true)],
        rpcReady: true,
      }),
    ).toBe("enabled");
    expect(
      resolveDesignPluginGateStatus({
        error: null,
        loading: false,
        plugins: [plugin(false)],
        rpcReady: true,
      }),
    ).toBe("disabled");
    expect(
      resolveDesignPluginGateStatus({
        error: "plugins/list failed",
        loading: false,
        plugins: [],
        rpcReady: true,
      }),
    ).toBe("error");
    expect(
      resolveDesignPluginGateStatus({
        error: null,
        loading: true,
        plugins: [],
        rpcReady: false,
      }),
    ).toBe("loading");
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
