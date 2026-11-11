import type {
  ImageEditorComposerScope,
  ImageEditorComposerTarget,
  ImageEditorOutput,
} from "./contract.js";

/** 只由当前会话/草稿的 Composer 响应；事件名使用 NIBI 前缀，避免与宿主其它事件冲突。 */
const REQUEST_IMAGE_COMPOSER_TARGET = "nibi:image-preview-composer-target";

interface ComposerTargetRequest {
  scope?: ImageEditorComposerScope;
  target: ImageEditorComposerTarget | null;
}

export interface CaptureImageComposerTargetOptions {
  /** 预览所属的会话/草稿；缺省时取第一个注册的可用输入框。 */
  scope?: ImageEditorComposerScope;
  events?: EventTarget | null;
}

export interface RegisterImageComposerTargetOptions {
  target: ImageEditorComposerTarget;
  /** Composer 自身的会话/草稿身份；用于匹配预览请求。 */
  scope?: ImageEditorComposerScope;
}

function defaultEvents(): EventTarget | null {
  return typeof window === "undefined" ? null : window;
}

function sameScope(
  registered: ImageEditorComposerScope,
  requested: ImageEditorComposerScope,
): boolean {
  if (registered.workspaceKey !== requested.workspaceKey) return false;
  if (registered.sessionId !== requested.sessionId) return false;
  // 活跃会话以 sessionId 为准；草稿态才需要比对项目草稿作用域。
  if (requested.sessionId === null) {
    return (registered.draftScopeKey ?? "") === (requested.draftScopeKey ?? "");
  }
  return true;
}

/**
 * 同步捕获当前接收方。导出是异步的，不能在导出完成后重新查找，
 * 否则可能把附件追加到另一个会话的输入框。
 */
export function captureImageComposerTarget(
  options: CaptureImageComposerTargetOptions = {},
): ImageEditorComposerTarget | null {
  const events = options.events === undefined ? defaultEvents() : options.events;
  if (!events || typeof CustomEvent === "undefined") return null;
  const detail: ComposerTargetRequest = {
    ...(options.scope ? { scope: options.scope } : {}),
    target: null,
  };
  events.dispatchEvent(
    new CustomEvent<ComposerTargetRequest>(REQUEST_IMAGE_COMPOSER_TARGET, { detail }),
  );
  return detail.target;
}

/**
 * 注册当前 Composer 的附件接收器。多个 pane 可能同时 focused，因此带作用域的请求
 * 只由会话/草稿完全匹配的 Composer 认领；同一请求只接受第一个命中的接收方。
 * 返回释放函数；接收器在释放后必须拒绝旧请求（`active` 门闩），
 * 防止关闭对话框时仍在途的导出写入已卸载的输入框。
 */
export function registerImageComposerTarget(
  registration: RegisterImageComposerTargetOptions,
  events: EventTarget | null = defaultEvents(),
): () => void {
  if (!events) return () => undefined;
  const { target, scope } = registration;
  let active = true;
  const receive = (event: Event) => {
    const request = (event as CustomEvent<ComposerTargetRequest>).detail;
    if (!request || request.target) return;
    if (request.scope) {
      if (!scope || !sameScope(scope, request.scope)) return;
    }
    request.target = {
      appendImage: (output) => active && target.appendImage(output),
    };
  };
  events.addEventListener(REQUEST_IMAGE_COMPOSER_TARGET, receive);
  return () => {
    active = false;
    events.removeEventListener(REQUEST_IMAGE_COMPOSER_TARGET, receive);
  };
}

/**
 * 把编辑器输出转成输入框可接收的 File。
 * 只构造文件，不绕过附件 admission；大小/数量/上传仍由 Composer 的既有队列裁决。
 */
export function createImageEditorAttachmentFile(output: ImageEditorOutput): File {
  return new File([output.bytes.slice()], output.filename, { type: output.mediaType });
}
