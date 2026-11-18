import { useCallback, useEffect, useRef } from "react";
import { EMBEDDED_BROWSER_DESIGN_BRIDGE, EmbeddedBrowserWebviewChannels } from "@nibi/shared";
import {
  buildDesignRuntimeCommandScript,
  buildDesignRuntimeInstallScript,
  parseDesignPageInfo,
  parseDesignRuntimeEvents,
  parseDesignRuntimeReply,
  type DesignPageInfo,
  type DesignRuntimeCommand,
  type DesignRuntimeEvent,
} from "@nibi/design-runtime";
import { logger } from "@/logger.js";

// 设计工具的宿主 ↔ 页面通信：
//
//   进入设计模式 / dom-ready / 重新加载 ──install script──▶ onInstalled(info)
//   页面 postMessage ──固定 guest preload──sendToHost──▶ ipc-message(DesignEvents) ──▶ onEvent
//   宿主 → 页面：run(command) 走 executeJavaScript
//
// 注入代号每次安装递增，迟到的旧页面注入结果丢弃。页面可伪造事件，这里只调用
// design-runtime 的宿主解析器（有长度/数量上限），写回仍由 FileService 二次校验。

export type DesignRuntimeWebview = Pick<
  ElectronWebviewTag,
  "executeJavaScript" | "addEventListener" | "removeEventListener"
>;

/** dom-ready 之前（或 guest 已卸下）executeJavaScript 会同步抛错；不兜住会冒到 React 渲染树。 */
function evaluate(webview: DesignRuntimeWebview, code: string): Promise<unknown> {
  try {
    return webview.executeJavaScript(code);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

export function useBrowserDesignRuntime({
  active,
  onEvent,
  onInstalled,
  webview,
  webviewGeneration,
}: {
  /** 运行时是否要装在页面里（设计模式打开时） */
  active: boolean;
  onEvent: (event: DesignRuntimeEvent) => void;
  /** 每次（重新）注入成功后调用；宿主据此恢复选中、清空过期状态 */
  onInstalled: (info: DesignPageInfo) => void;
  webview: DesignRuntimeWebview | null;
  webviewGeneration: number;
}) {
  const webviewRef = useRef(webview);
  webviewRef.current = webview;
  const callbacks = useRef({ onEvent, onInstalled });
  callbacks.current = { onEvent, onInstalled };

  const run = useCallback(async (command: DesignRuntimeCommand): Promise<unknown> => {
    const target = webviewRef.current;
    if (!target) return null;
    try {
      const reply = parseDesignRuntimeReply(
        await evaluate(target, buildDesignRuntimeCommandScript(command)),
      );
      return reply.ok ? reply.result : null;
    } catch (error) {
      logger.debug("[BrowserDesign] 设计运行时命令失败", {
        command: command.type,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }, []);

  useEffect(() => {
    if (!active || !webview) return;
    let disposed = false;
    let generation = 0;
    const install = () => {
      generation += 1;
      const current = generation;
      void evaluate(
        webview,
        buildDesignRuntimeInstallScript(EMBEDDED_BROWSER_DESIGN_BRIDGE.messageKey),
      )
        .then((value) => {
          const reply = parseDesignRuntimeReply(value);
          const info = reply.ok ? parseDesignPageInfo(reply.result) : null;
          if (!disposed && current === generation && info) callbacks.current.onInstalled(info);
        })
        .catch((error: unknown) => {
          // dom-ready 之前 guest 还不能执行脚本；等下一次 dom-ready 再装。
          logger.debug("[BrowserDesign] 设计运行时注入失败", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    };
    const handleIpcMessage = (event: ElectronWebviewIpcMessageEvent) => {
      if (event.channel !== EmbeddedBrowserWebviewChannels.DesignEvents) return;
      for (const designEvent of parseDesignRuntimeEvents(event.args[0])) {
        callbacks.current.onEvent(designEvent);
      }
    };
    webview.addEventListener("dom-ready", install);
    webview.addEventListener("ipc-message", handleIpcMessage);
    install();
    return () => {
      disposed = true;
      webview.removeEventListener("dom-ready", install);
      webview.removeEventListener("ipc-message", handleIpcMessage);
      // 退出设计模式不 dispose：写进源码的页面预览（CSS 变量 / 元素样式）要留在页面上；
      // 离开页面或卸载 webview 时才还原页面。
    };
  }, [active, webview, webviewGeneration]);

  useEffect(() => {
    if (!webview) return;
    const target = webview;
    return () => {
      // 组件卸载 / guest 被替换：还原浮层、预览样式与 CSS 变量。
      void evaluate(target, buildDesignRuntimeCommandScript({ type: "dispose" })).catch(
        () => undefined,
      );
    };
  }, [webview, webviewGeneration]);

  return { run };
}
