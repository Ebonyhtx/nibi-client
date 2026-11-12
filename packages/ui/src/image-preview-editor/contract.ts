/**
 * 图片预览编辑器契约。
 *
 * 输入是图片原始字节与自然尺寸，编辑器只读原字节；输出是带标注的 PNG 字节。
 * 「发送到输入框」通过 `ImageEditorComposerTarget.appendImage` 同步交给宿主输入框，
 * 宿主必须复用既有附件 admission（大小、数量、上传队列）；编辑器不发送消息、
 * 不直接调用服务层，也不持有上传队列。
 */
export interface ImageEditorInput {
  /** 原图字节（PNG/JPEG/WebP 等浏览器可解码的位图）；只读。 */
  bytes: Uint8Array;
  /** 原图 MIME 类型，用于构造预览 Blob。 */
  mediaType: string;
  /** 原图自然像素宽（导出画布尺寸）。 */
  width: number;
  /** 原图自然像素高（导出画布尺寸）。 */
  height: number;
  /** 下载/附件文件名；仅用于生成 `*-annotated.png` 名称。 */
  filename?: string;
}

export interface ImageEditorOutput {
  /** 带标注的 PNG 字节，画布尺寸等于输入的自然尺寸。 */
  bytes: Uint8Array;
  mediaType: "image/png";
  /** 安全的附件文件名，已带 `.png` 后缀。 */
  filename: string;
  /** 像素宽（与输入一致）。 */
  width: number;
  /** 像素高（与输入一致）。 */
  height: number;
  /** 相对输入是否发生修改；至少存在一条标注时为 true。 */
  changed: boolean;
}

/**
 * 输入框接收方：由当前聚焦的 Composer 注册。
 * 同步返回 true 表示附件已被既有队列接收；false（含达到附件上限）时编辑器不得假装成功。
 */
export interface ImageEditorComposerTarget {
  appendImage: (output: ImageEditorOutput) => boolean;
}

/**
 * 接收方作用域。主/辅 pane 的 Composer 可能同时处于 focused，
 * 预览面板必须把附件投递给同一个会话/草稿，而不是注册顺序里的第一个输入框。
 * 三者都来自既有会话投影，不新增协议字段。
 */
export interface ImageEditorComposerScope {
  sessionId: string | null;
  workspaceKey: string;
  /** 草稿作用域；仅在 sessionId 为空时参与完全匹配。 */
  draftScopeKey?: string;
}

export interface ImageAnnotationDialogProps {
  open: boolean;
  input: ImageEditorInput;
  /** 预览所属的会话/草稿；缺省时退回“第一个可用输入框”。 */
  composerScope?: ImageEditorComposerScope;
  onOpenChange: (open: boolean) => void;
  /** 成功把标注图片加入输入框后回调；编辑器自身不关闭对话框。 */
  onAppended?: (output: ImageEditorOutput) => void;
}

export interface ImageEditorSurfaceProps {
  input: ImageEditorInput;
  /** 预览所属的会话/草稿；缺省时退回“第一个可用输入框”。 */
  composerScope?: ImageEditorComposerScope;
  /** 关闭编辑器但不产生附件。 */
  onClose: () => void;
  /** 已加入输入框；由外层决定是否关闭。 */
  onAppended: (output: ImageEditorOutput) => void;
  /**
   * 保存按钮文案。独立标注对话框保持 `imageEditor.send`；
   * 会话图片预览内嵌时换成 `imagePreview.saveToConversation`。
   */
  saveLabelId?: string;
  /** 保存按钮位置；预览内嵌用左下角，独立对话框保持左上角。 */
  savePlacement?: "top-left" | "bottom-left";
  /** 保存按钮 test id；供预览内嵌入口的自动化用例定位。 */
  saveTestId?: string;
  /** 空态提示文案；预览内嵌时换成“编辑后可保存到对话”。 */
  emptyHintId?: string;
}
