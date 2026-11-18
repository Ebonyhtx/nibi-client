import { useCallback, useEffect, useRef, useState } from "react";
import type { IFileService } from "@nibi/services";
import {
  DESIGN_PAGE_LIMITS,
  type DesignPageInfo,
  type DesignRuntimeCommand,
  type DesignRuntimeEvent,
  type DesignSelectedElement,
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
import { logger } from "@/logger.js";

// 设计模式状态 owner（每个浏览器 tab 一份）：
// - 页面运行时只报告选中元素；选中集合、CSS 变量预览和写回任务都在宿主侧；
// - 面板改动经 useBrowserDesignSourceWriter 写回源文件，带 expected-content 校验；
// - 写成功后用固定命令把源码里的结果重新注入页面；失败时撤回预览并显示真实错误。

export type DesignSaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "error"; messageId: string };

const SAVE_ERROR_MESSAGES: Record<DesignWriteFailureReason, string> = {
  notLocal: "browser.design.source.pageUnavailable",
  read: "browser.design.save.readFailed",
  notFound: "browser.design.save.notFound",
  changed: "browser.design.save.changed",
  write: "browser.design.save.writeFailed",
  stale: "browser.design.save.stale",
};

export function designSaveErrorMessageId(reason: DesignWriteFailureReason): string {
  return SAVE_ERROR_MESSAGES[reason];
}

const selectorOf = (selection: DesignSelectedElement) => selection.element.selector ?? "";

export function useBrowserDesignMode({
  currentUrl,
  enabled,
  fileService,
  onBeforeActivate,
  webview,
  webviewGeneration,
  workspacePath,
}: {
  currentUrl: string;
  /** human Browser surface 才允许设计写回；agent Browser Use 传 false。 */
  enabled: boolean;
  /** 写回本机源文件用；没有服务时设计模式不可用 */
  fileService: IFileService | undefined;
  /** 进入点选前回调：取消正在进行的元素 chip 选择（两者都拦截页面点击） */
  onBeforeActivate?: () => void;
  webview: DesignRuntimeWebview | null;
  webviewGeneration: number;
  workspacePath: string | undefined;
}) {
  const pageKey = toDesignPageKey(currentUrl);
  const sourceAvailable = designSourcePathForBrowserUrl(currentUrl) !== null;
  const available =
    enabled && sourceAvailable && Boolean(workspacePath) && fileService !== undefined;

  const [active, setActive] = useState(false);
  const [pageInfo, setPageInfo] = useState<DesignPageInfo | null>(null);
  const [selections, setSelections] = useState<readonly DesignSelectedElement[]>([]);
  /** 选中元素都能在源码里找到；null 表示还在查 */
  const [writable, setWritable] = useState<boolean | null>(null);
  /** 源文件读不了（不在 workspace、不是 UTF-8、太大、读写报错） */
  const [sourceUnreadable, setSourceUnreadable] = useState(false);
  const [textWritable, setTextWritable] = useState(false);
  const [variablePreview, setVariablePreview] = useState<Record<string, string>>({});
  const [saveState, setSaveState] = useState<DesignSaveState>({ status: "idle" });

  const writer = useBrowserDesignSourceWriter({
    fileService,
    pageUrl: currentUrl,
    workspacePath,
  });
  const { checkWritable } = writer;

  // 异步回调（注入完成、事件、写回完成）读最新值，不依赖闭包里的旧 state。
  const stateRef = useRef({
    active,
    pageKey,
    selections,
    textWritable,
    variablePreview,
  });
  stateRef.current = { active, pageKey, selections, textWritable, variablePreview };
  const runRef = useRef<((command: DesignRuntimeCommand) => Promise<unknown>) | null>(null);
  const runLatest = useCallback(
    (command: DesignRuntimeCommand) => runRef.current?.(command) ?? Promise.resolve(null),
    [],
  );

  const clearSelection = useCallback(() => {
    stateRef.current.selections = [];
    setSelections([]);
    setWritable(null);
    setTextWritable(false);
    setSourceUnreadable(false);
  }, []);

  const deactivate = useCallback(() => {
    setActive(false);
    setPageInfo(null);
    setSaveState({ status: "idle" });
    clearSelection();
    void runLatest({ type: "set-mode", mode: "off" });
    void runLatest({ type: "set-selection", selectors: [] });
  }, [clearSelection, runLatest]);

  // 选中变了就按当前源码核对一次；结果对不上最新选中就丢掉。
  const checkGenerationRef = useRef(0);
  const refreshWritable = useCallback(
    (items: readonly DesignSelectedElement[]) => {
      const generation = ++checkGenerationRef.current;
      if (items.length === 0) {
        setWritable(null);
        setTextWritable(false);
        setSourceUnreadable(false);
        return;
      }
      setWritable(null);
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
      // 写成功后的 set-selection 读回是同一组元素：保留「已写入」状态；
      // 用户改选别的元素（或清空）才把上一次保存状态清掉。
      const previous = stateRef.current.selections.map(selectorOf).join("\n");
      const next = items.map(selectorOf).join("\n");
      if (previous !== next) setSaveState({ status: "idle" });
      stateRef.current.selections = items;
      setSelections(items);
      refreshWritable(items);
    },
    [refreshWritable],
  );

  const handleEvent = useCallback(
    (event: DesignRuntimeEvent) => {
      switch (event.type) {
        case "selection-changed":
          applySelections(event.selections);
          return;
        case "mode-changed":
          // 页面里按 Esc 退出点选 = 退出设计模式
          if (event.mode === "off") deactivate();
          return;
        default:
          // slide / stage / variant 不在本切片内。
          return;
      }
    },
    [applySelections, deactivate],
  );

  const handleInstalled = useCallback(
    (info: DesignPageInfo) => {
      setPageInfo(info);
      clearSelection();
      setSaveState({ status: "idle" });
      void runLatest({ type: "set-mode", mode: "select" });
      void runLatest({ type: "set-selection", selectors: [] });
      // 同一页面重新注入（刷新后）时，把本 tab 已写进源码的变量预览重新盖上。
      const preview = stateRef.current.variablePreview;
      if (Object.keys(preview).length > 0) {
        void runLatest({ type: "set-css-variables", values: preview });
      }
    },
    [clearSelection, runLatest],
  );

  const { run } = useBrowserDesignRuntime({
    active: active && available,
    onEvent: handleEvent,
    onInstalled: handleInstalled,
    webview,
    webviewGeneration,
  });
  runRef.current = run;

  // 换页面：选中、源文件核对和变量预览都不再属于新页面。
  useEffect(() => {
    checkGenerationRef.current += 1;
    clearSelection();
    setPageInfo(null);
    setSaveState({ status: "idle" });
    setVariablePreview({});
    stateRef.current.variablePreview = {};
  }, [pageKey, clearSelection]);

  // 页面不再是本地 HTML / 服务缺席：退出设计模式，不能继续假装可写。
  useEffect(() => {
    if (available) return;
    if (stateRef.current.active) deactivate();
  }, [available, deactivate]);

  const toggle = useCallback(() => {
    if (stateRef.current.active) {
      deactivate();
      return;
    }
    if (!available) return;
    onBeforeActivate?.();
    setSaveState({ status: "idle" });
    setActive(true);
  }, [available, deactivate, onBeforeActivate]);

  const refreshSelection = useCallback(() => {
    const selectors = stateRef.current.selections.map(selectorOf);
    if (selectors.length > 0) void runLatest({ type: "set-selection", selectors });
  }, [runLatest]);

  const commitStyle = useCallback(
    async (property: DesignStyleProperty, value: string) => {
      const primary = stateRef.current.selections.at(-1);
      if (!primary || value.trim() === "") return;
      const selector = selectorOf(primary);
      const cssName = DESIGN_STYLE_CSS_NAMES[property];
      const beforeStyle = primary.styleAttribute;
      const beforeText = primary.editable.text;
      setSaveState({ status: "saving" });
      void runLatest({ type: "set-element-properties", selector, styles: { [cssName]: value } });

      const result = await writer.commitElement({
        selection: primary,
        styles: { [cssName]: value },
      });
      if (result.status === "written") {
        // 页面以源码里的 style 为准：重新写成源码合并后的结果，再按选择器读回面板值。
        void runLatest({ type: "set-element-style", selector, style: result.styleAfter });
        if (result.textAfter !== undefined) {
          void runLatest({ type: "set-element-text", selector, text: result.textAfter });
        }
        setSaveState({ status: "saved" });
        refreshSelection();
        return;
      }
      // stale 表示页面已切换，不再往新页面发旧选择器的命令。
      if (result.reason !== "stale") {
        void runLatest({ type: "set-element-style", selector, style: beforeStyle });
        if (beforeText !== null) {
          void runLatest({ type: "set-element-text", selector, text: beforeText });
        }
      }
      setSaveState({
        status: "error",
        messageId: designSaveErrorMessageId(result.reason),
      });
    },
    [refreshSelection, runLatest, writer],
  );

  const commitText = useCallback(
    async (text: string) => {
      const primary = stateRef.current.selections.at(-1);
      if (!primary || !stateRef.current.textWritable) return;
      if (stateRef.current.selections.length !== 1) return;
      if ((primary.editable.text ?? "").length >= DESIGN_PAGE_LIMITS.longText) return;
      if (text === primary.editable.text) return;
      const selector = selectorOf(primary);
      setSaveState({ status: "saving" });
      void runLatest({ type: "set-element-text", selector, text });

      const result = await writer.commitElement({ selection: primary, text });
      if (result.status === "written") {
        void runLatest({ type: "set-element-text", selector, text: result.textAfter ?? text });
        setSaveState({ status: "saved" });
        refreshSelection();
        return;
      }
      if (result.reason !== "stale") {
        void runLatest({ type: "set-element-text", selector, text: primary.editable.text ?? "" });
      }
      setSaveState({
        status: "error",
        messageId: designSaveErrorMessageId(result.reason),
      });
    },
    [refreshSelection, runLatest, writer],
  );

  const commitVariable = useCallback(
    async (name: string, value: string) => {
      if (!name.startsWith("--") || value.trim() === "") return;
      setSaveState({ status: "saving" });
      const result = await writer.commitVariable(name, value);
      if (result.status === "written") {
        const next = { ...stateRef.current.variablePreview, [name]: value };
        stateRef.current.variablePreview = next;
        setVariablePreview(next);
        void runLatest({ type: "set-css-variables", values: next });
        setSaveState({ status: "saved" });
        return;
      }
      setSaveState({
        status: "error",
        messageId: designSaveErrorMessageId(result.reason),
      });
    },
    [runLatest, writer],
  );

  useEffect(() => {
    if (!active) return;
    logger.debug("[BrowserDesign] 设计模式已打开", { pageKey });
  }, [active, pageKey]);

  return {
    available,
    active,
    canWriteSource: writer.canWrite,
    sourceFileName: writer.fileName,
    toggle,
    deactivate,
    pageInfo,
    selections,
    primary: selections.at(-1) ?? null,
    writable,
    sourceUnreadable,
    textWritable: textWritable && selections.length === 1,
    variablePreview,
    saveState,
    commitStyle,
    commitText,
    commitVariable,
  };
}

export type BrowserDesignModeController = ReturnType<typeof useBrowserDesignMode>;
