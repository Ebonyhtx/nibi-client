import {
  BROWSER_LOCAL_PREVIEW_SCHEME,
  EMBEDDED_BROWSER_DESIGN_BRIDGE,
  EmbeddedBrowserWebviewChannels,
} from "@nibi/shared";

// 设计运行时页面 → 宿主的转发。
// 运行时在页面主世界 `window.postMessage({ __nibiDesign: 1, events })`；这里在固定 guest preload
// 的隔离世界收下，只认自己窗口发给自己的、来自本地 HTML 预览页、带命名空间且大小在上限内的消息，
// 再 sendToHost 给宿主。页面脚本仍能伪造这种消息：宿主侧解析还会逐字段校验和截断，结果只会变成
// 用户看得见、能删的上下文；能写源码的路径另有 workspace 约束与 expected-content 校验。

type SendToHost = (channel: string, payload: unknown) => void;

const utf8 = new TextEncoder();
const SIGNED_PREVIEW_HOST_RE = /^[a-f0-9]{64}$/u;

/**
 * 只有本地 HTML 页面可以走设计桥：原始 file:（无 host，拒绝 UNC/网络共享）或
 * 主进程签名的 nibi-html://<hmac>/<encodedRoot>/<file> 预览页。
 */
export function isEmbeddedBrowserDesignSourceUrl(rawUrl: string | undefined): boolean {
  try {
    const url = new URL(rawUrl ?? "");
    if (url.protocol === "file:") return url.host === "" && !url.port;
    if (url.protocol !== `${BROWSER_LOCAL_PREVIEW_SCHEME}:`) return false;
    if (url.port || url.username || url.password) return false;
    if (!SIGNED_PREVIEW_HOST_RE.test(url.hostname)) return false;
    const [, encodedRoot, ...segments] = url.pathname.split("/");
    return Boolean(encodedRoot) && segments.length > 0;
  } catch {
    return false;
  }
}

/** 合法时返回 events 数组，否则 null（来源不是自己窗口、不是本地预览页、结构不对或太大）。 */
export function readEmbeddedBrowserDesignMessage(
  event: Pick<MessageEvent, "data" | "source">,
  targetWindow: Window,
): unknown[] | null {
  if (event.source !== targetWindow) return null;
  let pageHref: string | undefined;
  try {
    pageHref = targetWindow.location?.href;
  } catch {
    return null;
  }
  if (!isEmbeddedBrowserDesignSourceUrl(pageHref)) return null;
  const data: unknown = event.data;
  if (typeof data !== "object" || data === null) return null;
  const envelope = data as Record<string, unknown>;
  if (envelope[EMBEDDED_BROWSER_DESIGN_BRIDGE.messageKey] !== 1) return null;
  if (!Array.isArray(envelope.events) || envelope.events.length === 0) return null;
  let bytes: number;
  try {
    // 上限按 UTF-8 字节计（中文等多字节字符按实际体积算）
    bytes = utf8.encode(JSON.stringify(envelope.events)).byteLength;
  } catch {
    return null;
  }
  return bytes <= EMBEDDED_BROWSER_DESIGN_BRIDGE.maxMessageBytes ? envelope.events : null;
}

/**
 * 按键当下的真实目标是不是可编辑元素。composedPath 穿过 Shadow DOM 拿到最里层的输入框；
 * 同源 iframe 里的按键不会冒到顶层文档，本来就收不到。
 */
function isEditableKeyTarget(event: KeyboardEvent): boolean {
  for (const node of event.composedPath()) {
    if (!(node instanceof Element)) continue;
    if (node instanceof HTMLElement && node.isContentEditable) return true;
    if (node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.tagName === "SELECT") {
      return true;
    }
  }
  return false;
}

/**
 * 页面上的 Cmd/Ctrl + Z（Shift 为重做）。只认浏览器派发的真实按键（isTrusted，页面 dispatchEvent 造不出来），
 * 在 capture 阶段、页面自己的处理器之前判断按键目标；焦点在页面输入框里时归页面撤销输入，不通知宿主。
 * 目标页面由 install 时已校验的本地预览地址决定，这里不额外信任按键内容。
 */
export function readEmbeddedBrowserDesignUndoKey(
  event: KeyboardEvent,
): { redo: boolean } | null {
  if (!event.isTrusted || event.repeat || event.altKey) return null;
  if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "z") return null;
  return isEditableKeyTarget(event) ? null : { redo: event.shiftKey };
}

/** 在固定 guest preload 里安装；返回解绑函数。 */
export function installEmbeddedBrowserDesignBridge(
  targetWindow: Window,
  sendToHost: SendToHost,
): () => void {
  const handleMessage = (event: MessageEvent): void => {
    // 只有本地预览页会装这个桥；页面来源校验与事件解析共用同一条路径。
    if (!isEmbeddedBrowserDesignSourceUrl(readTargetHref(targetWindow))) return;
    const events = readEmbeddedBrowserDesignMessage(event, targetWindow);
    if (events) sendToHost(EmbeddedBrowserWebviewChannels.DesignEvents, events);
  };
  const handleKeyDown = (event: KeyboardEvent): void => {
    if (!isEmbeddedBrowserDesignSourceUrl(readTargetHref(targetWindow))) return;
    const undo = readEmbeddedBrowserDesignUndoKey(event);
    if (undo) sendToHost(EmbeddedBrowserWebviewChannels.DesignUndoShortcut, undo);
  };
  targetWindow.addEventListener("message", handleMessage);
  targetWindow.addEventListener("keydown", handleKeyDown, true);
  return () => {
    targetWindow.removeEventListener("message", handleMessage);
    targetWindow.removeEventListener("keydown", handleKeyDown, true);
  };
}

function readTargetHref(targetWindow: Window): string | undefined {
  try {
    return targetWindow.location?.href;
  } catch {
    return undefined;
  }
}
