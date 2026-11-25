import type { HighlighterTypes } from "@pierre/diffs";
import type { WorkerInitializationRenderOptions } from "@pierre/diffs/react";
import type { BundledTheme } from "shiki";
import {
  createContext,
  createElement,
  useContext,
  useMemo,
  type Context,
  type ReactNode,
} from "react";

/**
 * @pierre/diffs 默认使用 shiki 的 JavaScript 正则引擎（shiki-js）。该引擎把 TextMate
 * 语法逐条翻译成巨型 RegExp 并在引擎级缓存里永久持有，V8 会把执行过的正则编译成原生代码放进
 * code space；双字节文本（中文注释等）还会再编译一份。主窗口和 4 个 diff worker 共用同一个
 * 256MB code range，长时间运行后会被这些正则占满，触发 renderer 的 V8 OOM
 * （CALL_AND_RETRY_LAST，old-space 仍有大量空闲，code cage "ran out of reservation"）。
 * oniguruma WASM 引擎的正则活在 wasm 线性内存里，不占 V8 代码区，且是 TextMate 语法的参考实现。
 */
export const DIFFS_PREFERRED_HIGHLIGHTER: HighlighterTypes = "shiki-wasm";

export interface DiffsHighlighterThemeSettings {
  lightTheme: BundledTheme;
  darkTheme: BundledTheme;
}

/** diff worker 池初始化参数；主线程兜底渲染与 worker 必须使用同一个引擎选择。 */
export function createDiffsWorkerHighlighterOptions(
  settings: DiffsHighlighterThemeSettings,
): WorkerInitializationRenderOptions {
  return {
    theme: {
      light: settings.lightTheme,
      dark: settings.darkTheme,
    },
    // 不同 patch 的逐词差异计算会额外占用主线程；先沿用库默认阈值，
    // 后续可基于慢日志再单独收紧，避免一次改动引入“高亮信息突然消失”的回归。
    lineDiffType: "word-alt",
    maxLineDiffLength: 1_000,
    tokenizeMaxLineLength: 1_000,
    useTokenTransformer: false,
    preferredHighlighter: DIFFS_PREFERRED_HIGHLIGHTER,
  };
}

let workerPoolRequested = false;
let poolFactory: (() => unknown) | null = null;
const activationListeners = new Set<() => void>();
const FALLBACK_EMPTY_WORKER_POOL_CONTEXT = createContext<unknown>(undefined);

export function registerDiffsWorkerPoolFactory(factory: () => unknown): void {
  poolFactory = factory;
}

export function isDiffsWorkerPoolRequested(): boolean {
  return workerPoolRequested;
}

export function requestDiffsWorkerPool(): void {
  if (workerPoolRequested) {
    return;
  }
  workerPoolRequested = true;
  queueMicrotask(() => {
    for (const listener of activationListeners) {
      listener();
    }
    activationListeners.clear();
  });
}

export function ensureDiffsWorkerPoolSync<T>(): T | undefined {
  requestDiffsWorkerPool();
  return poolFactory ? (poolFactory() as T) : undefined;
}

export function subscribeDiffsWorkerPoolActivation(listener: () => void): () => void {
  if (workerPoolRequested) {
    return () => {};
  }
  activationListeners.add(listener);
  return () => {
    activationListeners.delete(listener);
  };
}

export function useEnsuredDiffsWorkerPool<T>(
  workerPoolContext: Context<T | undefined> | undefined,
  disabled = false,
): {
  activePool: T | undefined;
  renderWithWorkerPool: (node: ReactNode) => ReactNode;
} {
  const existingPool = useContext(
    (workerPoolContext ?? FALLBACK_EMPTY_WORKER_POOL_CONTEXT) as Context<T | undefined>,
  );
  const activePool = useMemo(() => {
    if (disabled || typeof Worker === "undefined") {
      return undefined;
    }
    return existingPool ?? ensureDiffsWorkerPoolSync<T>();
  }, [disabled, existingPool]);

  const Provider = workerPoolContext?.Provider;
  const renderWithWorkerPool = useMemo(() => {
    if (!Provider || disabled || typeof Worker === "undefined") {
      return (node: ReactNode) => node;
    }
    return (node: ReactNode) => createElement(Provider, { value: activePool }, node);
  }, [Provider, activePool, disabled]);

  return { activePool, renderWithWorkerPool };
}
