import { useCallback, useEffect, useRef } from "react";
import type { IFileService } from "@nibi/services";
import {
  locateSourceCssVariable,
  locateSourceElement,
  rewriteSourceCssVariable,
  rewriteSourceElement,
  type DesignSelectedElement,
} from "@nibi/design-runtime";
import { designSourcePathForBrowserUrl, toDesignPageKey } from "@/browser-use/browserDesign.js";
import { logger } from "@/logger.js";

// 属性面板写回源文件。源文件是唯一事实：每次写都先读当前内容、在它上面改、带
// 「仍是读到的那份」校验写回；文件被 Agent 或编辑器改过就返回 changed，宁可失败也不覆盖。
// 这里不做页面预览 / 撤销栈 / 自动刷新；页面重注入由 useBrowserDesignMode 在写成功后发命令完成。

export type DesignWriteFailureReason =
  | "notLocal"
  | "read"
  | "notFound"
  | "changed"
  | "write"
  | "stale";

export type DesignElementWriteResult =
  | {
      status: "written";
      styleBefore: string | null;
      styleAfter: string | null;
      textBefore?: string;
      textAfter?: string;
    }
  | { status: "failed"; reason: DesignWriteFailureReason };

export type DesignVariableWriteResult =
  | { status: "written"; before: string; after: string }
  | { status: "failed"; reason: DesignWriteFailureReason };

export interface DesignSourceCheck {
  /** false 表示源文件读不了（不在 workspace、不是 UTF-8、太大、读写报错） */
  readable: boolean;
  elements: Array<{ located: boolean; textWritable: boolean }>;
}

export interface DesignElementEdit {
  selection: DesignSelectedElement;
  /** CSS 属性名 → 值（null 删除） */
  styles?: Record<string, string | null>;
  text?: string;
}

export function useBrowserDesignSourceWriter({
  fileService,
  pageUrl,
  workspacePath,
}: {
  fileService: IFileService | undefined;
  /** 换页面时排队中的任务作废 */
  pageUrl: string;
  workspacePath: string | undefined;
}) {
  const path = designSourcePathForBrowserUrl(pageUrl);
  const pageKey = toDesignPageKey(pageUrl);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const generationRef = useRef(0);

  useEffect(() => {
    generationRef.current += 1;
    queueRef.current = Promise.resolve();
  }, [pageKey]);

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

  const write = useCallback(
    async (expectedContent: string, content: string): Promise<"written" | "changed" | "error"> => {
      if (!path || !workspacePath || !fileService) return "error";
      try {
        const { written } = await fileService.writeDesignSourceFile({
          path,
          workspacePath,
          expectedContent,
          content,
        });
        return written ? "written" : "changed";
      } catch (error) {
        logger.warn("[BrowserDesign] 写源文件失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        return "error";
      }
    },
    [fileService, path, workspacePath],
  );

  const enqueue = useCallback(<T>(task: (alive: () => boolean) => Promise<T>): Promise<T> => {
    const generation = generationRef.current;
    const next = queueRef.current.then(() => task(() => generationRef.current === generation));
    queueRef.current = next.catch(() => undefined);
    return next;
  }, []);

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

  const commitElement = useCallback(
    (edit: DesignElementEdit): Promise<DesignElementWriteResult> =>
      enqueue(async (alive): Promise<DesignElementWriteResult> => {
        if (!path || !workspacePath || !fileService) {
          return { status: "failed", reason: "notLocal" };
        }
        const before = await read();
        if (!alive()) return { status: "failed", reason: "stale" };
        if (before === null) return { status: "failed", reason: "read" };

        const location = locateSourceElement(before, edit.selection.source);
        if (!location) return { status: "failed", reason: "notFound" };
        const after = rewriteSourceElement(before, location, {
          ...(edit.styles ? { styles: edit.styles } : {}),
          ...(edit.text !== undefined ? { text: edit.text } : {}),
        });
        if (after === null) return { status: "failed", reason: "notFound" };

        const writtenLocation = locateSourceElement(after, edit.selection.source);
        if (!writtenLocation) return { status: "failed", reason: "notFound" };
        const result: DesignElementWriteResult = {
          status: "written",
          styleBefore: location.style?.value ?? null,
          styleAfter: writtenLocation.style?.value ?? null,
          ...(edit.text !== undefined
            ? { textBefore: location.text?.value ?? "", textAfter: edit.text }
            : {}),
        };
        if (after === before) return result;

        const outcome = await write(before, after);
        if (!alive()) return { status: "failed", reason: "stale" };
        if (outcome === "written") return result;
        return { status: "failed", reason: outcome === "changed" ? "changed" : "write" };
      }),
    [enqueue, fileService, path, read, workspacePath, write],
  );

  const commitVariable = useCallback(
    (name: string, value: string): Promise<DesignVariableWriteResult> =>
      enqueue(async (alive): Promise<DesignVariableWriteResult> => {
        if (!path || !workspacePath || !fileService) {
          return { status: "failed", reason: "notLocal" };
        }
        const before = await read();
        if (!alive()) return { status: "failed", reason: "stale" };
        if (before === null) return { status: "failed", reason: "read" };

        const range = locateSourceCssVariable(before, name);
        const after = range ? rewriteSourceCssVariable(before, name, value) : null;
        if (!range || after === null) return { status: "failed", reason: "notFound" };
        const result: DesignVariableWriteResult = {
          status: "written",
          before: before.slice(range.start, range.end),
          after: value,
        };
        if (after === before) return result;

        const outcome = await write(before, after);
        if (!alive()) return { status: "failed", reason: "stale" };
        if (outcome === "written") return result;
        return { status: "failed", reason: outcome === "changed" ? "changed" : "write" };
      }),
    [enqueue, fileService, path, read, workspacePath, write],
  );

  return {
    canWrite: path !== null && workspacePath !== undefined && fileService !== undefined,
    fileName: path?.split(/[\\/]/u).pop() ?? null,
    checkWritable,
    commitElement,
    commitVariable,
  };
}
