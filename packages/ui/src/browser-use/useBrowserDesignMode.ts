import { useCallback, useEffect, useRef, useState } from "react";
import type { IFileService } from "@nibi/services";
import {
  DESIGN_PAGE_LIMITS,
  type DesignInteractionMode,
  type DesignPageInfo,
  type DesignPageSignals,
  type DesignRuntimeCommand,
  type DesignRuntimeEvent,
  type DesignSelectedElement,
  type PageElementRect,
} from "@nibi/design-runtime";
import {
  DESIGN_STYLE_CSS_NAMES,
  designSourcePathForBrowserUrl,
  toDesignPageKey,
  type DesignStyleProperty,
} from "@/browser-use/browserDesign.js";
import {
  useBrowserDesignRuntime,
  type DesignRuntimeWebview,
} from "@/browser-use/useBrowserDesignRuntime.js";
import {
  useBrowserDesignSourceWriter,
  type DesignWriteFailureReason,
} from "@/browser-use/useBrowserDesignSourceWriter.js";
import { browserLocalPreviewSourceUrl } from "@/embeddedBrowserHelpers.js";
import {
  createWebElementContextId,
  dispatchWebElementContextAddToChat,
  dispatchWebElementContextRemoveFromChat,
  type WebElementContextPayload,
} from "@/lib/webElementContext.js";
import { logger } from "@/logger.js";

// 设计模式状态 owner（每个浏览器 tab 一份）：
// - 页面运行时只报告选中元素；选中集合、CSS 变量预览、方案、翻页和写回任务都在宿主侧；
// - 选中元素以网页元素引用进输入框（像 Goal / Skill 一样由 composer 接收并显示 chip）；
// - 面板改动经 useBrowserDesignSourceWriter 写回源文件，带 expected-content 校验；
// - 页面重注入（刷新 / 自动重载）后按选择器恢复选中（pins），并重新推方案与变量预览。

export type DesignSaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "error"; messageId: string };

export interface DesignChipTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

const SAVE_ERROR_MESSAGES: Record<DesignWriteFailureReason | "empty", string> = {
  notLocal: "browser.design.source.pageUnavailable",
  read: "browser.design.save.readFailed",
  notFound: "browser.design.save.notFound",
  changed: "browser.design.save.changed",
  write: "browser.design.save.writeFailed",
  stale: "browser.design.save.stale",
  empty: "browser.design.save.stale",
};

export function designSaveErrorMessageId(
  reason: DesignWriteFailureReason | "empty",
): string {
  return SAVE_ERROR_MESSAGES[reason];
}

const selectorOf = (selection: DesignSelectedElement) => selection.element.selector ?? "";

function isLocalPage(url: string): boolean {
  try {
    const source = browserLocalPreviewSourceUrl(url) ?? url;
    const { hostname, protocol } = new URL(source);
    return (
      protocol === "file:" ||
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

/**
 * 设计工具自动出现的条件：页面带 `data-nibi-design`；或是本机页面（file:// / localhost）且有
 * :root CSS 变量、data-variant 方案或 section.slide。普通网站很多也声明 :root 变量，所以只对本机页面看这几项。
 */
export function shouldAutoShowDesignTools(
  signals: DesignPageSignals,
  pageUrl: string,
): boolean {
  if (signals.isDesignDocument) return true;
  return (
    isLocalPage(pageUrl) &&
    (signals.cssVariableNames.length > 0 || signals.variants.length > 0 || signals.slideCount > 0)
  );
}

export function useBrowserDesignMode({
  captureElement,
  chipTarget,
  currentUrl,
  enabled,
  fileService,
  isVisible = true,
  onBeforeActivate,
  onNoChipTarget,
  pluginEnabled = true,
  requestPluginEnable,
  webview,
  webviewGeneration,
  workspacePath,
}: {
  /** 按视口 rect 由宿主取帧；不支持时为 undefined，截图动作隐藏 */
  captureElement?: (rect: PageElementRect) => Promise<ArrayBuffer | null>;
  /** 没有 workspace（Agent tab 等）时为 null，点选不进输入框 */
  chipTarget?: DesignChipTarget | null;
  currentUrl: string;
  /** human Browser surface 才允许设计模式；agent Browser Use 传 false。 */
  enabled: boolean;
  /** 写回本机源文件用；没有服务时只读 */
  fileService: IFileService | undefined;
  isVisible?: boolean;
  /** 进入点选前回调：取消正在进行的元素 chip 选择（两者都拦截页面点击） */
  onBeforeActivate?: () => void;
  /** 没有可接收的输入框：每轮点选只提示一次 */
  onNoChipTarget?: () => void;
  /** 当前工作区是否启用了内置 Design 插件 */
  pluginEnabled?: boolean;
  /** 插件未启用时请求用户确认并前往插件页；返回 true 才进入点选 */
  requestPluginEnable?: () => Promise<boolean>;
  webview: DesignRuntimeWebview | null;
  webviewGeneration: number;
  workspacePath: string | undefined;
}) {
  const pageKey = toDesignPageKey(currentUrl);
  const sourceAvailable = designSourcePathForBrowserUrl(currentUrl) !== null;
  const [mode, setModeState] = useState<DesignInteractionMode>("off");
  const [panelOpen, setPanelOpen] = useState(false);
  const [pageInfo, setPageInfo] = useState<DesignPageInfo | null>(null);
  const [selections, setSelections] = useState<readonly DesignSelectedElement[]>([]);
  /** 选中元素都能在源码里找到；null 表示还在查或没有选中 */
  const [writable, setWritable] = useState<boolean | null>(null);
  /** 源文件读不了（不在 workspace、不是 UTF-8、太大、读写报错） */
  const [sourceUnreadable, setSourceUnreadable] = useState(false);
  const [textWritable, setTextWritable] = useState(false);
  const [variablePreview, setVariablePreviewState] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<DesignSaveState>({ status: "idle" });
  const [variant, setVariantState] = useState<string | null>(null);
  const [slide, setSlide] = useState({ index: 0, count: 0 });
  const [signals, setSignals] = useState<{
    pageKey: string;
    signals: DesignPageSignals;
  } | null>(null);

  const autoToolsVisible =
    signals?.pageKey === pageKey && shouldAutoShowDesignTools(signals.signals, currentUrl);
  // 设计稿页面（设计产物）才出设计工具行、方案和翻页；插件停用时整组收起。
  // NIBI 的设计桥只接受本地 file: / 签名 nibi-html 预览页，所以能力也只在可写源码的本地 HTML 上开放。
  const toolsVisible = enabled && pluginEnabled && sourceAvailable && autoToolsVisible;
  // 人类 tab 的「选择元素」在本机 HTML 上就是这套点选；其他页面仍用原有元素选择器。
  const runtimeActive = pluginEnabled && (toolsVisible || (enabled && mode !== "off"));

  const latest = useRef({
    mode,
    pageKey,
    selections,
    textWritable,
    toolsVisible,
    variablePreview: variablePreview as Record<string, string>,
    variant,
  });
  latest.current = {
    mode,
    pageKey,
    selections,
    textWritable,
    toolsVisible,
    variablePreview,
    variant,
  };

  const runRef = useRef<((command: DesignRuntimeCommand) => Promise<unknown>) | null>(null);
  const runLatest = useCallback(
    (command: DesignRuntimeCommand) => runRef.current?.(command) ?? Promise.resolve(null),
    [],
  );

  const pushVariables = useCallback(
    (values: Record<string, string>) => {
      latest.current.variablePreview = values;
      setVariablePreviewState(values);
      void runLatest({ type: "set-css-variables", values });
    },
    [runLatest],
  );
  const setVariablePreview = useCallback(
    (name: string, value: string | null) => {
      const next = { ...latest.current.variablePreview };
      if (value === null) delete next[name];
      else next[name] = value;
      pushVariables(next);
    },
    [pushVariables],
  );

  const writer = useBrowserDesignSourceWriter({
    fileService,
    pageKey,
    pageUrl: currentUrl,
    run: runLatest,
    setVariablePreview,
    workspacePath,
  });
  const { checkWritable } = writer;
  const canWriteSource = writer.canWrite && sourceAvailable;

  // ---- 选中 → 输入框里的元素引用 ----
  // 选中集合变了就对一次账：取消选中的撤回，新选中的加进去。同一元素不会加两次。
  const chipsRef = useRef(new Map<string, string>());
  const noTargetNotifiedRef = useRef(false);
  const chipGenerationRef = useRef(0);

  const detachChips = useCallback(() => {
    chipsRef.current.clear();
    noTargetNotifiedRef.current = false;
    chipGenerationRef.current += 1;
  }, []);

  const selectionToPayload = useCallback(
    (selection: DesignSelectedElement, id: string): WebElementContextPayload | null => {
      if (!chipTarget) return null;
      return {
        ...selection.element,
        id,
        workspacePath: chipTarget.workspacePath,
        ...(chipTarget.workspaceIdentity
          ? { workspaceIdentity: chipTarget.workspaceIdentity }
          : {}),
      };
    },
    [chipTarget],
  );

  const reconcileChips = useCallback(() => {
    const items = latest.current.selections;
    const wanted = new Set(items.map(selectorOf));
    for (const [selector, id] of chipsRef.current) {
      if (wanted.has(selector) || !chipTarget) continue;
      dispatchWebElementContextRemoveFromChat({ id, ...chipTarget });
      chipsRef.current.delete(selector);
    }
    if (!chipTarget) {
      if (items.length > 0 && !noTargetNotifiedRef.current) {
        noTargetNotifiedRef.current = true;
        onNoChipTarget?.();
      }
      return;
    }
    for (const selection of items) {
      const selector = selectorOf(selection);
      if (!selector || chipsRef.current.has(selector)) continue;
      const id = createWebElementContextId();
      const payload = selectionToPayload(selection, id);
      if (!payload) continue;
      const accepted = dispatchWebElementContextAddToChat(payload);
      if (!accepted) {
        if (!noTargetNotifiedRef.current) {
          noTargetNotifiedRef.current = true;
          onNoChipTarget?.();
        }
        continue;
      }
      chipsRef.current.set(selector, id);
    }
    if (items.length > 0) noTargetNotifiedRef.current = false;
  }, [chipTarget, onNoChipTarget, selectionToPayload]);

  const clearSelection = useCallback(() => {
    latest.current.selections = [];
    setSelections([]);
    setWritable(null);
    setTextWritable(false);
    setSourceUnreadable(false);
  }, []);

  const setMode = useCallback(
    (next: DesignInteractionMode) => {
      const target = latest.current.mode === next ? "off" : next;
      if (target !== "off") onBeforeActivate?.();
      setModeState(target);
      latest.current.mode = target;
      void runLatest({ type: "set-mode", mode: target });
      if (target === "off") {
        // 退出点选 = 退出设计模式：面板一起收起，页面上的选中框也清掉。
        setPanelOpen(false);
        void runLatest({ type: "set-selection", selectors: [] });
        clearSelection();
        detachChips();
      }
    },
    [clearSelection, detachChips, onBeforeActivate, runLatest],
  );

  const requestSelectMode = useCallback(async () => {
    if (!isVisible || !enabled || !sourceAvailable) return;
    if (latest.current.mode !== "off") {
      setMode("select");
      return;
    }
    if (!pluginEnabled) {
      // 读取失败 / 未安装 / 未启用都走同一道门：确认只导航到插件页，不自动启用。
      const allowed = await requestPluginEnable?.();
      if (allowed) setMode("select");
      return;
    }
    setMode("select");
  }, [enabled, isVisible, pluginEnabled, requestPluginEnable, setMode]);

  const deactivate = useCallback(() => {
    setModeState("off");
    latest.current.mode = "off";
    setPanelOpen(false);
    setSaveState({ status: "idle" });
    clearSelection();
    detachChips();
    void runLatest({ type: "set-mode", mode: "off" });
    void runLatest({ type: "set-selection", selectors: [] });
  }, [clearSelection, detachChips, runLatest]);

  const toggle = useCallback(() => {
    if (latest.current.mode !== "off") {
      deactivate();
      return;
    }
    void requestSelectMode();
  }, [deactivate, requestSelectMode]);

  // 选中变了就按当前源码核对一次；结果对不上最新选中就丢掉。
  const checkGenerationRef = useRef(0);
  const checkedKeyRef = useRef("");
  const refreshWritable = useCallback(
    (items: readonly DesignSelectedElement[]) => {
      const generation = ++checkGenerationRef.current;
      if (items.length === 0) {
        checkedKeyRef.current = "";
        setWritable(null);
        setTextWritable(false);
        setSourceUnreadable(false);
        return;
      }
      const key = items.map(selectorOf).join("\n");
      if (key !== checkedKeyRef.current) setWritable(null);
      checkedKeyRef.current = key;
      void checkWritable(items).then(({ elements, readable }) => {
        if (generation !== checkGenerationRef.current) return;
        const all = readable && elements.every((element) => element.located);
        setWritable(all);
        setSourceUnreadable(!readable);
        setTextWritable(all && elements.length === 1 && elements[0]?.textWritable === true);
      });
    },
    [checkWritable],
  );

  const applySelections = useCallback(
    (items: readonly DesignSelectedElement[]) => {
      const previous = latest.current.selections.map(selectorOf).join("\n");
      const next = items.map(selectorOf).join("\n");
      if (previous !== next) setSaveState({ status: "idle" });
      latest.current.selections = items;
      setSelections(items);
      // 设计稿页面点中元素就打开属性面板；本机可写页面同样打开，普通网页只加进聊天、不自动弹面板挡页面。
      if (items.length > 0 && (latest.current.toolsVisible || canWriteSource)) setPanelOpen(true);
      refreshWritable(items);
      reconcileChips();
    },
    [canWriteSource, reconcileChips, refreshWritable],
  );

  const rereadSelections = useCallback(() => {
    const selectors = latest.current.selections.map(selectorOf);
    if (selectors.length > 0) void runLatest({ type: "set-selection", selectors });
  }, [runLatest]);

  const handleEvent = useCallback(
    (event: DesignRuntimeEvent) => {
      switch (event.type) {
        case "selection-changed":
          applySelections(event.selections);
          return;
        case "slide-changed":
          setSlide({ index: event.index, count: event.count });
          return;
        case "mode-changed":
          if (event.mode === "off") {
            setModeState("off");
            latest.current.mode = "off";
            setPanelOpen(false);
            void runLatest({ type: "set-selection", selectors: [] });
            clearSelection();
            detachChips();
          }
          return;
        case "stage-changed":
          setPageInfo((info) => (info ? { ...info, stageBackdrop: event.stageBackdrop } : info));
          return;
      }
    },
    [applySelections, clearSelection, detachChips, runLatest],
  );

  const lastInstalledKeyRef = useRef<string | null>(null);
  const handleInstalled = useCallback(
    (info: DesignPageInfo) => {
      setPageInfo(info);
      setSlide({ index: info.currentSlide, count: info.slideCount });
      const state = latest.current;
      const infoKey = toDesignPageKey(info.pageUrl);
      const switchedPage =
        lastInstalledKeyRef.current !== null && lastInstalledKeyRef.current !== infoKey;
      const samePage = lastInstalledKeyRef.current === infoKey;
      // 新文档：之前排队的对账（可能卡在旧文档的命令上）全部作废
      chipGenerationRef.current += 1;
      lastInstalledKeyRef.current = infoKey;
      // 刷新后源码就是事实：之前的变量预览值要么已经写进源码，要么被别人改掉了。
      latest.current.variablePreview = {};
      setVariablePreviewState({});
      if (switchedPage) {
        latest.current.mode = "off";
        latest.current.variant = null;
        setModeState("off");
        setPanelOpen(false);
        setVariantState(null);
      }
      if (!samePage) detachChips();
      // 换了页面：宿主侧选中一起清掉；同一页面刷新则保留（pins），按选择器恢复。
      if (!samePage && state.selections.length > 0) {
        latest.current.selections = [];
        setSelections([]);
        setWritable(null);
        setTextWritable(false);
        setSourceUnreadable(false);
      }
      void runLatest({ type: "set-mode", mode: state.mode });
      if (state.variant !== null) void runLatest({ type: "set-variant", variant: state.variant });
      if (samePage && state.selections.length > 0) {
        void runLatest({
          type: "set-selection",
          selectors: state.selections.map(selectorOf),
        });
      } else {
        void runLatest({ type: "set-selection", selectors: [] });
      }
    },
    [detachChips, runLatest],
  );

  const handleSignals = useCallback((next: DesignPageSignals, url: string) => {
    setSignals({ pageKey: toDesignPageKey(url), signals: next });
  }, []);

  const { run } = useBrowserDesignRuntime({
    active: runtimeActive,
    onEvent: handleEvent,
    onInstalled: handleInstalled,
    onSignals: handleSignals,
    probeEnabled: enabled && pluginEnabled,
    webview,
    webviewGeneration,
  });
  runRef.current = run;

  // 换页面：选中、源文件核对、变量预览和方案都不再属于新页面。
  useEffect(() => {
    checkGenerationRef.current += 1;
    latest.current.selections = [];
    setSelections([]);
    setWritable(null);
    setTextWritable(false);
    setSourceUnreadable(false);
    setPageInfo(null);
    setSaveState({ status: "idle" });
    latest.current.variablePreview = {};
    setVariablePreviewState({});
    latest.current.variant = null;
    setVariantState(null);
    setSignals(null);
    lastInstalledKeyRef.current = null;
    detachChips();
  }, [pageKey, detachChips]);

  // 页面不再是人类可用的设计表面（enabled 关闭）：退出，不能继续假装可写。
  useEffect(() => {
    if (enabled) return;
    if (latest.current.mode !== "off") deactivate();
  }, [deactivate, enabled]);

  // 插件停用：卸下运行时并清理临时选择；已进输入框的引用保留。
  useEffect(() => {
    if (pluginEnabled) return;
    if (latest.current.mode !== "off") deactivate();
    setSignals(null);
  }, [deactivate, pluginEnabled]);

  // 单页应用换路由不会重新注入运行时：地址一换也退出点选（about: 是导航途中的短暂占位，不算换页）。
  const lastPageKeyRef = useRef(pageKey);
  useEffect(() => {
    if (lastPageKeyRef.current === pageKey || pageKey.startsWith("about:")) return;
    lastPageKeyRef.current = pageKey;
    if (latest.current.mode !== "off") deactivate();
  }, [deactivate, pageKey]);

  const commitElements = useCallback(
    async (
      edits: Parameters<typeof writer.commitElements>[0],
    ): Promise<Awaited<ReturnType<typeof writer.commitElements>>> => {
      const result = await writer.commitElements(edits);
      if (result.status === "written") rereadSelections();
      return result;
    },
    [rereadSelections, writer],
  );

  const applySaveResult = useCallback(
    (result: Awaited<ReturnType<typeof writer.commitElements>>) => {
      if (result.status === "written") {
        setSaveState({ status: "saved" });
        return;
      }
      if (result.status === "stale") {
        setSaveState({ status: "idle" });
        return;
      }
      // 没有可撤销 / 重做的记录：按钮可以是常显的，不能报成写回失败。
      if (result.status === "failed" && result.reason === "empty") {
        setSaveState({ status: "idle" });
        return;
      }
      setSaveState({
        status: "error",
        messageId: designSaveErrorMessageId(result.reason),
      });
    },
    [],
  );

  const previewStyle = useCallback(
    (property: DesignStyleProperty, value: string) => {
      for (const selection of latest.current.selections) {
        void run({
          type: "set-element-properties",
          selector: selectorOf(selection),
          styles: { [DESIGN_STYLE_CSS_NAMES[property]]: value },
        });
      }
    },
    [run],
  );

  const commitStyle = useCallback(
    async (property: DesignStyleProperty, value: string) => {
      const items = latest.current.selections;
      if (items.length === 0 || value.trim() === "") return;
      previewStyle(property, value);
      setSaveState({ status: "saving" });
      const result = await commitElements(
        items.map((selection) => ({
          selection,
          styles: { [DESIGN_STYLE_CSS_NAMES[property]]: value },
        })),
      );
      applySaveResult(result);
    },
    [applySaveResult, commitElements, previewStyle],
  );

  const commitText = useCallback(
    async (text: string) => {
      const primary = latest.current.selections.at(-1);
      if (!primary || latest.current.selections.length !== 1) return;
      if ((primary.editable.text ?? "").length >= DESIGN_PAGE_LIMITS.longText) return;
      if (text === primary.editable.text) return;
      const selector = selectorOf(primary);
      void runLatest({ type: "set-element-text", selector, text });
      setSaveState({ status: "saving" });
      const result = await commitElements([{ selection: primary, text }]);
      applySaveResult(result);
    },
    [applySaveResult, commitElements, runLatest],
  );

  const commitVariable = useCallback(
    async (name: string, value: string) => {
      if (!name.startsWith("--") || value.trim() === "") return;
      setSaveState({ status: "saving" });
      const result = await writer.commitVariable(name, value);
      applySaveResult(result);
    },
    [applySaveResult, writer],
  );

  const undo = useCallback(async () => {
    setSaveState({ status: "saving" });
    const result = await writer.undo();
    if (result.status === "written") rereadSelections();
    applySaveResult(result);
  }, [applySaveResult, rereadSelections, writer]);

  const redo = useCallback(async () => {
    setSaveState({ status: "saving" });
    const result = await writer.redo();
    if (result.status === "written") rereadSelections();
    applySaveResult(result);
  }, [applySaveResult, rereadSelections, writer]);

  const setVariant = useCallback(
    (next: string | null) => {
      setVariantState(next);
      latest.current.variant = next;
      void run({ type: "set-variant", variant: next });
    },
    [run],
  );

  const goToSlide = useCallback(
    (index: number) => {
      if (index < 0 || index >= slide.count) return;
      setSlide((current) => ({ ...current, index }));
      void run({ type: "go-to-slide", index });
    },
    [run, slide.count],
  );

  const selectParent = useCallback(() => {
    void run({ type: "select-parent" });
  }, [run]);

  /** 捕获当前主选中元素：先隐藏浮层并滚动到可见，再由宿主取帧。截图只是附加产物，失败返回 null。 */
  const captureSelection = useCallback(async (): Promise<ArrayBuffer | null> => {
    const primary = latest.current.selections.at(-1);
    const selector = primary ? selectorOf(primary) : "";
    if (!primary || !selector || !captureElement) return null;
    try {
      const rect = (await runLatest({
        type: "locate-for-capture",
        selector,
      })) as PageElementRect | null;
      if (!rect || rect.width <= 0 || rect.height <= 0) return null;
      return await captureElement(rect);
    } catch (error) {
      logger.warn("[BrowserDesign] 元素截图失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    } finally {
      void runLatest({ type: "end-capture" });
    }
  }, [captureElement, runLatest]);

  useEffect(() => {
    if (mode === "off") return;
    logger.debug("[BrowserDesign] 设计模式已打开", { pageKey });
  }, [mode, pageKey]);

  return {
    /** 本机 HTML（可写回）才允许进入设计点选；插件未启用时由 requestSelectMode 走确认门 */
    available: enabled && sourceAvailable,
    active: mode !== "off",
    mode,
    toolsVisible,
    panelOpen,
    setPanelOpen,
    requestSelectMode,
    toggle,
    deactivate,
    pageInfo,
    selections,
    primary: selections.at(-1) ?? null,
    writable,
    sourceUnreadable,
    textWritable:
      textWritable && (selections.at(-1)?.editable.text ?? "").length < DESIGN_PAGE_LIMITS.longText,
    canWriteSource,
    sourceFileName: writer.fileName,
    variablePreview,
    saveState,
    variant,
    setVariant,
    slide,
    goToSlide,
    selectParent,
    commitStyle,
    commitText,
    commitVariable,
    undo,
    redo,
    captureSelection,
    captureAvailable: Boolean(captureElement),
    isOwnSourceWrite: writer.isOwnWrite,
  };
}

export type BrowserDesignModeController = ReturnType<typeof useBrowserDesignMode>;