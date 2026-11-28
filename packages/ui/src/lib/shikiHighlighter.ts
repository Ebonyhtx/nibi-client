import type { BundledLanguage, BundledTheme, HighlighterCore, ThemedToken } from "shiki";
// 只静态引入语言清单/别名表（约 28KB 元数据），语法本体仍是各语言的动态 import。
// 这样 shouldUseSyntaxHighlighting 可以保持同步，而 createHighlighterCore、Oniguruma
// 引擎和 wasm 只有在真正出现代码块时才加载，不会进入首屏静态图。
import { bundledLanguages, bundledLanguagesInfo } from "shiki/langs";
import { logger } from "@/logger.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

export interface TokenizedCode {
  tokens: ThemedToken[][];
  fg: string;
  bg: string;
}

const bundledLanguageIds = new Set(Object.keys(bundledLanguages));
const bundledLanguageAliases = new Map(
  bundledLanguagesInfo.flatMap((info) =>
    (info.aliases ?? []).map((alias) => [alias, info.id] as const),
  ),
);
const FALLBACK_CODE_LANGUAGE: BundledLanguage = "log";
const PLAIN_TEXT_CODE_LANGUAGES = new Set([
  "",
  "text",
  "txt",
  "plain",
  "plaintext",
  "log",
  "output",
]);

export function shouldUseSyntaxHighlighting(language: string): boolean {
  const candidate = language.trim().toLowerCase();
  if (PLAIN_TEXT_CODE_LANGUAGES.has(candidate)) {
    return false;
  }

  return bundledLanguageIds.has(candidate) || bundledLanguageAliases.has(candidate);
}

function normalizeCodeLanguage(language: string): BundledLanguage {
  const candidate = language.trim().toLowerCase();
  if (!candidate) {
    return FALLBACK_CODE_LANGUAGE;
  }

  const alias = bundledLanguageAliases.get(candidate);
  if (alias && bundledLanguageIds.has(alias)) {
    return alias as BundledLanguage;
  }

  if (bundledLanguageIds.has(candidate)) {
    return candidate as BundledLanguage;
  }

  return FALLBACK_CODE_LANGUAGE;
}

const MAX_TOKENS_CACHE_ENTRIES = 200;
const tokensCache = new Map<string, TokenizedCode>();

function getCachedTokens(key: string): TokenizedCode | undefined {
  const cached = tokensCache.get(key);
  if (cached === undefined) {
    return undefined;
  }
  tokensCache.delete(key);
  tokensCache.set(key, cached);
  return cached;
}

function setCachedTokens(key: string, value: TokenizedCode): void {
  if (tokensCache.has(key)) {
    tokensCache.delete(key);
  } else if (tokensCache.size >= MAX_TOKENS_CACHE_ENTRIES) {
    const oldestKey = tokensCache.keys().next().value;
    if (oldestKey !== undefined) {
      tokensCache.delete(oldestKey);
    }
  }
  tokensCache.set(key, value);
}

const subscribers = new Map<string, Set<(result: TokenizedCode) => void>>();
const inFlightTokenizeKeys = new Set<string>();
let singletonHighlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLanguages = new Set<BundledLanguage>();
const loadedThemes = new Set<BundledTheme>();
const inFlightLanguageLoads = new Map<BundledLanguage, Promise<void>>();
const inFlightThemeLoads = new Map<BundledTheme, Promise<void>>();

// 内存诊断计数器：全局仅保留单个 HighlighterCore + 单个 Oniguruma WASM 实例，
// 避免多语言/亮暗切换时每组 `(theme, language)` 重复实例化 WASM 线性内存。
uiMemoryDiagnosticsRegistry.register("shiki", () => ({
  tokensCache: tokensCache.size,
  highlighters: singletonHighlighterPromise ? 1 : 0,
  loadedLanguages: loadedLanguages.size,
  loadedThemes: loadedThemes.size,
}));

const getResolvedCodeTheme = (theme?: BundledTheme): BundledTheme => {
  if (theme) {
    return theme;
  }

  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
    return "github-dark";
  }

  return "github-light";
};

const getCodeTokensCacheKey = (code: string, language: BundledLanguage, theme: BundledTheme) => {
  const start = code.slice(0, 100);
  const end = code.length > 100 ? code.slice(-100) : "";
  return `${theme}:${language}:${code.length}:${start}:${end}`;
};
interface ShikiCoreModules {
  createHighlighterCore: typeof import("shiki/core").createHighlighterCore;
  createOnigurumaEngine: typeof import("shiki/engine/oniguruma").createOnigurumaEngine;
  bundledThemes: typeof import("shiki/themes").bundledThemes;
}

let shikiCoreModulesPromise: Promise<ShikiCoreModules> | null = null;

// Shiki core + Oniguruma + wasm 全部走运行时动态 import：
// - 本模块首屏只保留上面的语言清单/别名元数据，不再静态引入高亮引擎、主题和 wasm；
//   （@pierre/diffs 自己的 shiki 依赖不在本模块控制范围内，见报告中的后续项）
// - 某个 chunk 加载失败时清掉缓存，后续代码块还能重试；
// - 失败不会向上抛出到 React，调用方继续显示纯文本。
const loadShikiCoreModules = (): Promise<ShikiCoreModules> => {
  if (!shikiCoreModulesPromise) {
    shikiCoreModulesPromise = Promise.all([
      import("shiki/core"),
      import("shiki/engine/oniguruma"),
      import("shiki/themes"),
    ])
      .then(([core, engine, themes]) => ({
        createHighlighterCore: core.createHighlighterCore,
        createOnigurumaEngine: engine.createOnigurumaEngine,
        bundledThemes: themes.bundledThemes,
      }))
      .catch((error: unknown) => {
        shikiCoreModulesPromise = null;
        throw error;
      });
  }

  return shikiCoreModulesPromise;
};

const getSingletonHighlighter = (): Promise<HighlighterCore> => {
  if (!singletonHighlighterPromise) {
    singletonHighlighterPromise = loadShikiCoreModules()
      .then(({ createHighlighterCore, createOnigurumaEngine }) =>
        createHighlighterCore({
          langs: [],
          themes: [],
          engine: createOnigurumaEngine(import("shiki/wasm")),
        }),
      )
      .catch((error: unknown) => {
        singletonHighlighterPromise = null;
        throw error;
      });
  }
  return singletonHighlighterPromise;
};

const ensureLanguageLoaded = async (
  highlighter: HighlighterCore,
  language: BundledLanguage,
): Promise<void> => {
  if (loadedLanguages.has(language)) return;
  const inflight = inFlightLanguageLoads.get(language);
  if (inflight) {
    await inflight;
    return;
  }
  const loader = bundledLanguages[language];
  if (!loader) {
    throw new Error(`Unsupported Shiki language: ${language}`);
  }
  const task = highlighter
    .loadLanguage(loader)
    .then(() => {
      loadedLanguages.add(language);
    })
    .finally(() => {
      inFlightLanguageLoads.delete(language);
    });
  inFlightLanguageLoads.set(language, task);
  await task;
};

const ensureThemeLoaded = async (
  highlighter: HighlighterCore,
  theme: BundledTheme,
): Promise<void> => {
  if (loadedThemes.has(theme)) return;
  const inflight = inFlightThemeLoads.get(theme);
  if (inflight) {
    await inflight;
    return;
  }
  const { bundledThemes } = await loadShikiCoreModules();
  const loader = bundledThemes[theme];
  if (!loader) {
    throw new Error(`Unsupported Shiki theme: ${theme}`);
  }
  const task = highlighter
    .loadTheme(loader)
    .then(() => {
      loadedThemes.add(theme);
    })
    .finally(() => {
      inFlightThemeLoads.delete(theme);
    });
  inFlightThemeLoads.set(theme, task);
  await task;
};

const getHighlighter = async (
  language: BundledLanguage,
  theme: BundledTheme,
): Promise<HighlighterCore> => {
  const highlighter = await getSingletonHighlighter();
  await Promise.all([
    ensureLanguageLoaded(highlighter, language),
    ensureThemeLoaded(highlighter, theme),
  ]);
  return highlighter;
};

export const createRawCodeTokens = (code: string): TokenizedCode => ({
  bg: "transparent",
  fg: "inherit",
  tokens: code.split("\n").map((line) =>
    line === ""
      ? []
      : [
          {
            color: "inherit",
            content: line,
          } as ThemedToken,
        ],
  ),
});

// 带缓存的异步高亮入口；React 组件只应在 effect 中调用。
export const highlightCode = (
  code: string,
  language: string,
  theme?: BundledTheme,
  // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-callbacks)
  callback?: (result: TokenizedCode) => void,
): TokenizedCode | null => {
  if (!shouldUseSyntaxHighlighting(language)) {
    // 文本/日志代码块没有语法高亮收益，却会在聊天流式渲染和历史恢复时进入
    // Shiki 的异步状态机。之前修掉了 render 阶段 setState，但这条纯文本路径仍可能把
    // CodeViewer 拖进 React #185；这里直接返回 raw tokens，避免启动高亮副作用。
    return createRawCodeTokens(code);
  }

  const resolvedTheme = getResolvedCodeTheme(theme);
  const resolvedLanguage = normalizeCodeLanguage(language);
  const tokensCacheKey = getCodeTokensCacheKey(code, resolvedLanguage, resolvedTheme);

  const cached = getCachedTokens(tokensCacheKey);
  if (cached) {
    // 缓存命中时也需要通知 effect，但不能同步触发 setState。
    // 历史消息恢复时大量代码块会在同一次提交后挂载；同步 callback 会把 cache-hit 变成嵌套更新，
    // 和 Streamdown 的重渲染叠在一起时容易触发 React #185。推迟到微任务后再交给幂等 setter。
    if (callback) {
      queueMicrotask(() => callback(cached));
    }
    return cached;
  }

  if (callback) {
    if (!subscribers.has(tokensCacheKey)) {
      subscribers.set(tokensCacheKey, new Set());
    }
    subscribers.get(tokensCacheKey)?.add(callback);
  }

  if (inFlightTokenizeKeys.has(tokensCacheKey)) {
    return null;
  }
  inFlightTokenizeKeys.add(tokensCacheKey);

  getHighlighter(resolvedLanguage, resolvedTheme)
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then)
    .then((highlighter) => {
      const availableLangs = highlighter.getLoadedLanguages();
      const langToUse = availableLangs.includes(resolvedLanguage)
        ? resolvedLanguage
        : FALLBACK_CODE_LANGUAGE;

      const result = highlighter.codeToTokens(code, {
        lang: langToUse,
        theme: resolvedTheme,
      });

      const tokenized: TokenizedCode = {
        bg: "transparent",
        fg: result.fg ?? "inherit",
        tokens: result.tokens,
      };

      setCachedTokens(tokensCacheKey, tokenized);

      const subs = subscribers.get(tokensCacheKey);
      subscribers.delete(tokensCacheKey);
      inFlightTokenizeKeys.delete(tokensCacheKey);
      if (subs) {
        for (const sub of subs) {
          sub(tokenized);
        }
      }
    })
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then), eslint-plugin-promise(prefer-await-to-callbacks)
    .catch((error) => {
      // Shiki 加载或 tokenize 失败，组件会停留在无高亮的 rawTokens 状态。
      logger.error(
        `[ShikiHighlighter] 代码高亮失败: language=${resolvedLanguage}, theme=${resolvedTheme}`,
        error,
      );
      subscribers.delete(tokensCacheKey);
      inFlightTokenizeKeys.delete(tokensCacheKey);
    });

  return null;
};

/** 取消尚未完成的高亮订阅，防止组件卸载后回调集一直滞留闭包。 */
export const unsubscribeHighlightCode = (
  code: string,
  language: string,
  theme: BundledTheme | undefined,
  callback: (result: TokenizedCode) => void,
): void => {
  if (!shouldUseSyntaxHighlighting(language)) {
    return;
  }
  const resolvedTheme = getResolvedCodeTheme(theme);
  const resolvedLanguage = normalizeCodeLanguage(language);
  const tokensCacheKey = getCodeTokensCacheKey(code, resolvedLanguage, resolvedTheme);
  const subs = subscribers.get(tokensCacheKey);
  if (!subs) return;
  subs.delete(callback);
  if (subs.size === 0) {
    subscribers.delete(tokensCacheKey);
  }
};
