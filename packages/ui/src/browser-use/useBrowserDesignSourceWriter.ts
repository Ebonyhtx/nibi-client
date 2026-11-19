import { useCallback, useEffect, useRef } from "react";
import type { IFileService } from "@nibi/services";
import {
  locateSourceCssVariable,
  locateSourceElement,
  rewriteSourceCssVariable,
  rewriteSourceElement,
  type DesignRuntimeCommand,
  type DesignSelectedElement,
} from "@nibi/design-runtime";
import { designSourcePathForBrowserUrl, toDesignPageKey } from "@/browser-use/browserDesign.js";
import { logger } from "@/logger.js";

// 属性面板写回源文件与撤销（docs/browser-use/2026-11-03-browser-design-mode-spec.md 第五节）。
// 源文件是唯一事实：每次写都先读当前内容、在它上面改、带「仍是读到的那份」校验写回；
// 撤销同样要求文件仍是那次写入的结果。写入失败时页面按这次任务实际读到的源码撤回，
// 任务排队期间换了页面（导航、刷新到别的地址）就作废，不再碰新页面。
// 本文件不做页面预览状态：变量预览由 useBrowserDesignMode 拥有，写成功 / 撤销 / 撤回时回调它。

/** 一次写回对页面的影响：撤销 / 重做时按它把页面恢复成写前 / 写后的样子 */
interface ElementChange {
  selector: string;
  styleBefore: string | null;
  styleAfter: string | null;
  textBefore?: string;
  textAfter?: string;
}

interface VariableChange {
  name: string;
  before: string;
  after: string;
}

interface WriteEntry {
  path: string;
  before: string;
  after: string;
  elements: ElementChange[];
  variables: VariableChange[];
}

type WritePlan = Omit<WriteEntry, "path" | "before">;

/** written：写进源文件；failed：没写进（页面已撤回）；stale：排队期间换了页面，什么都不再动 */
export type DesignWriteResult = "written" | "failed" | "stale";

export type DesignWriteFailureReason =
  | "notLocal"
  | "read"
  | "notFound"
  | "changed"
  | "write"
  | "stale";

export type DesignHistoryStepResult =
  | { status: "written" }
  | { status: "failed"; reason: DesignWriteFailureReason | "empty" }
  | { status: "stale" };

export interface DesignElementWriteResult {
  status: "written";
  entries: number;
}

/** 选中元素在当前源码里的情况：readable 为 false 表示源文件读不了（不是 UTF-8、太大、读写报错） */
export interface DesignSourceCheck {
  readable: boolean;
  elements: Array<{ located: boolean; textWritable: boolean }>;
}

export interface DesignElementEdit {
  selection: DesignSelectedElement;
  /** CSS 属性名 → 值（null 删除） */
  styles?: Record<string, string | null>;
  text?: string;
}

/** 认作「自己写的」最近几次写回内容：连续写回时文件事件会晚到，任一次对上都不刷新 */
const OWN_WRITE_HISTORY = 4;

export function useBrowserDesignSourceWriter({
  fileService,
  pageKey,
  pageUrl,
  run,
  setVariablePreview,
  workspacePath,
}: {
  fileService: IFileService | undefined;
  /** 换页面时撤销栈与排队中的任务作废 */
  pageKey?: string;
  pageUrl: string;
  run: (command: DesignRuntimeCommand) => Promise<unknown>;
  /** 页面上 CSS 变量的预览值归 useBrowserDesignMode 管；写成 / 撤销 / 撤回时由这里告诉它 */
  setVariablePreview: (name: string, value: string | null) => void;
  workspacePath: string | undefined;
}) {
  const path = designSourcePathForBrowserUrl(pageUrl);
  const resolvedPageKey = pageKey ?? toDesignPageKey(pageUrl);
  const undoRef = useRef<WriteEntry[]>([]);
  const redoRef = useRef<WriteEntry[]>([]);
  // 写入串行：上一次没写完就读，会在旧内容上改，校验必然失败
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  // 任务入队时记下页面代际，每个 await 之后对不上就作废
  const generationRef = useRef(0);
  /**
   * 这个 tab 最后一次写入的内容：自动刷新看到文件内容与它相同就不刷新（页面已经是这个样子）。
   * Bugfix（!3450 Q-design-own-writes-scope）：只归这个 tab，读到别的内容（外部改过）或换页面就失效。
   */
  const ownWriteRef = useRef<{ key: string; contents: string[] } | null>(null);

  useEffect(() => {
    generationRef.current += 1;
    undoRef.current = [];
    redoRef.current = [];
    ownWriteRef.current = null;
  }, [resolvedPageKey]);

  /** 串行执行；task 拿到 alive()，页面换了之后为 false */
  const enqueue = useCallback(<T>(task: (alive: () => boolean) => Promise<T>): Promise<T> => {
    const generation = generationRef.current;
    const next = queueRef.current.then(() => task(() => generationRef.current === generation));
    queueRef.current = next.catch(() => undefined);
    return next;
  }, []);

  const read = useCallback(async (): Promise<string | null> => {
    if (!path || !workspacePath || !fileService) return null;
    try {
      return (await fileService.readDesignSourceFile({ path, workspacePath })).content;
    } catch (error) {
      logger.warn("[BrowserDesign] 读源文件失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }, [fileService, path, workspacePath]);

  /** changed：文件已不是读到的那份；error：读写报错（权限、磁盘等） */
  const write = useCallback(
    async (expected: string, content: string): Promise<"written" | "changed" | "error"> => {
      if (!path || !workspacePath || !fileService) return "error";
      const key = path.replace(/\\/g, "/").replace(/\/+$/u, "").toLowerCase();
      const previous = ownWriteRef.current?.key === key ? ownWriteRef.current.contents : [];
      const own = { key, contents: [...previous.slice(-(OWN_WRITE_HISTORY - 1)), content] };
      ownWriteRef.current = own;
      // 没写进去：撤掉这次预先记下的内容
      const forget = () => {
        if (ownWriteRef.current === own) ownWriteRef.current = { key, contents: previous };
      };
      try {
        const { written } = await fileService.writeDesignSourceFile({
          path,
          workspacePath,
          expectedContent: expected,
          content,
        });
        if (!written) forget();
        return written ? "written" : "changed";
      } catch (error) {
        forget();
        logger.warn("[BrowserDesign] 写源文件失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        return "error";
      }
    },
    [fileService, path, workspacePath],
  );

  /** 自动刷新问：主 HTML 的这次变化是不是这个 tab 自己写的 */
  const isOwnWrite = useCallback(
    async (changedPath: string): Promise<boolean> => {
      const own = ownWriteRef.current;
      const key = changedPath.replace(/\\/g, "/").replace(/\/+$/u, "").toLowerCase();
      if (!own || own.key !== key || !workspacePath || !fileService) return false;
      try {
        const { content } = await fileService.readDesignSourceFile({
          path: changedPath,
          workspacePath,
        });
        if (own.contents.includes(content)) {
          // 对上第 i 次就把它和更早的几次都消费掉；已确认过的版本不再算自写，外部改回它时照常刷新
          const current = ownWriteRef.current;
          const index = current?.key === own.key ? current.contents.indexOf(content) : -1;
          if (current && index >= 0) {
            ownWriteRef.current = { key: current.key, contents: current.contents.slice(index + 1) };
          }
          return true;
        }
      } catch {
        // 读不到按别人的改动处理：刷新
      }
      if (ownWriteRef.current === own) ownWriteRef.current = null;
      return false;
    },
    [fileService, workspacePath],
  );

  /** 这些选中元素能不能写回（源码里按路径找得到）、能不能改字（源码里只含文字） */
  const checkWritable = useCallback(
    async (selections: readonly DesignSelectedElement[]): Promise<DesignSourceCheck> => {
      const source = await read();
      return {
        readable: source !== null,
        elements: selections.map((selection) => {
          const location = source === null ? null : locateSourceElement(source, selection.source);
          return { located: location !== null, textWritable: location?.text != null };
        }),
      };
    },
    [read],
  );

  const applyToPage = useCallback(
    (entry: Pick<WriteEntry, "elements" | "variables">, direction: "before" | "after") => {
      for (const change of entry.elements) {
        const style = direction === "before" ? change.styleBefore : change.styleAfter;
        void run({ type: "set-element-style", selector: change.selector, style });
        const text = direction === "before" ? change.textBefore : change.textAfter;
        if (text !== undefined)
          void run({ type: "set-element-text", selector: change.selector, text });
      }
      for (const change of entry.variables) {
        setVariablePreview(change.name, direction === "before" ? change.before : change.after);
      }
    },
    [run, setVariablePreview],
  );

  /**
   * plan 在这次任务读到的源码上算出改动；revert 在没写进去时把页面撤回到这次读到的源码
   *（读不到源码时为 null，由 revert 自己决定回到哪）。
   */
  const commit = useCallback(
    (plan: (source: string) => WritePlan | null, revert: (source: string | null) => void) =>
      enqueue(async (alive): Promise<DesignHistoryStepResult> => {
        if (!path) return { status: "failed", reason: "notLocal" };
        if (!workspacePath || !fileService) return { status: "failed", reason: "notLocal" };
        const before = await read();
        if (!alive()) return { status: "stale" };
        const fail = (reason: DesignWriteFailureReason): DesignHistoryStepResult => {
          revert(before);
          return { status: "failed", reason };
        };
        if (before === null) return fail("read");
        const result = plan(before);
        if (!result) return fail("notFound");
        if (result.after === before) return { status: "written" };
        const outcome = await write(before, result.after);
        // 文件可能已经写进去了，但页面换了：新页面会按源码加载，不再动它
        if (!alive()) return { status: "stale" };
        if (outcome !== "written") return fail(outcome === "changed" ? "changed" : "write");
        const entry = { path, before, ...result };
        undoRef.current.push(entry);
        redoRef.current = [];
        applyToPage(entry, "after");
        return { status: "written" };
      }),
    [applyToPage, enqueue, fileService, path, read, workspacePath, write],
  );

  /** 改元素：每个元素在上一个改完的源码上重新定位（前面的改动会挪动后面的偏移） */
  const commitElements = useCallback(
    (edits: readonly DesignElementEdit[]): Promise<DesignHistoryStepResult> =>
      commit(
        (source) => {
          let after = source;
          const elements: ElementChange[] = [];
          for (const edit of edits) {
            const location = locateSourceElement(after, edit.selection.source);
            if (!location) return null;
            const next = rewriteSourceElement(after, location, {
              ...(edit.styles ? { styles: edit.styles } : {}),
              ...(edit.text !== undefined ? { text: edit.text } : {}),
            });
            if (next === null) return null;
            const written = locateSourceElement(next, edit.selection.source);
            elements.push({
              selector: edit.selection.element.selector ?? "",
              styleBefore: location.style?.value ?? null,
              styleAfter: written?.style?.value ?? null,
              // 写前文字取这次读到的源码，不用选中时的快照
              ...(edit.text !== undefined
                ? { textBefore: location.text?.value ?? "", textAfter: edit.text }
                : {}),
            });
            after = next;
          }
          return { after, elements, variables: [] };
        },
        (source) => {
          // 按这次任务读到的源码撤回，而不是提交时的选中快照：连续提交时前一次已写成，
          // 按快照撤回会把前一次的结果也抹掉。只有源码读不到时才退回到选中快照。
          for (const edit of edits) {
            const selector = edit.selection.element.selector ?? "";
            const location =
              source === null ? null : locateSourceElement(source, edit.selection.source);
            const style = location
              ? (location.style?.value ?? null)
              : edit.selection.styleAttribute;
            void run({ type: "set-element-style", selector, style });
            const text = location?.text?.value ?? edit.selection.editable.text;
            if (edit.text !== undefined && text !== null) {
              void run({ type: "set-element-text", selector, text });
            }
          }
        },
      ),
    [commit, run],
  );

  const commitVariable = useCallback(
    (name: string, value: string): Promise<DesignHistoryStepResult> =>
      commit(
        (source) => {
          const range = locateSourceCssVariable(source, name);
          const after = range ? rewriteSourceCssVariable(source, name, value) : null;
          if (!range || after === null) return null;
          const before = source.slice(range.start, range.end);
          return { after, elements: [], variables: [{ name, before, after: value }] };
        },
        (source) => {
          // 按这次读到的源码里的值撤回预览；读不到就去掉预览，回到页面样式表里的值
          const range = source === null ? null : locateSourceCssVariable(source, name);
          setVariablePreview(
            name,
            source !== null && range ? source.slice(range.start, range.end) : null,
          );
        },
      ),
    [commit, setVariablePreview],
  );

  const step = useCallback(
    (redo: boolean): Promise<DesignHistoryStepResult> =>
      enqueue(async (alive): Promise<DesignHistoryStepResult> => {
        const from = redo ? redoRef.current : undoRef.current;
        const entry = from[from.length - 1];
        if (!entry) return { status: "failed", reason: "empty" };
        const current = await read();
        if (!alive()) return { status: "stale" };
        const expected = redo ? entry.before : entry.after;
        const outcome =
          current === expected
            ? await write(expected, redo ? entry.after : entry.before)
            : "changed";
        if (!alive()) return { status: "stale" };
        // 文件在这之后被 Agent 或别人改过：还原会把那些改动一起抹掉，所以不还原，撤销栈也作废
        if (outcome !== "written") {
          undoRef.current = [];
          redoRef.current = [];
          return {
            status: "failed",
            reason: outcome === "changed" ? "changed" : "write",
          };
        }
        from.pop();
        (redo ? undoRef : redoRef).current.push(entry);
        applyToPage(entry, redo ? "after" : "before");
        return { status: "written" };
      }),
    [applyToPage, enqueue, read, write],
  );

  return {
    /** 页面是本机 HTML 文件、可以写回 */
    canWrite: path !== null && workspacePath !== undefined && fileService !== undefined,
    fileName: path?.split(/[\\/]/u).pop() ?? null,
    checkWritable,
    commitElements,
    commitVariable,
    isOwnWrite,
    undo: useCallback(() => step(false), [step]),
    redo: useCallback(() => step(true), [step]),
  };
}
