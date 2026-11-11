# 图片预览编辑（image-preview-editor）

在现有图片预览之上提供画笔、箭头、矩形、椭圆、文字与橡皮擦标注，撤销/重做/清除，
并把带标注的图片作为 PNG **附件**交回当前会话输入框。编辑器不发送消息，也不直接调用上传服务。

## 边界

- 输入：`ImageEditorInput`（原图字节、MIME、自然宽高、可选文件名）。原字节只读，编辑器不写回源文件。
- 坐标：所有标注点与线宽使用归一化 0–1 坐标；窗口尺寸、预览适配倍率与滚轮缩放都不会改变标注语义。
  导出时按输入的自然尺寸重建画布，因此输出像素与当前窗口大小无关。
- 输出：`ImageEditorOutput`（带标注的 PNG 字节、`image/png`、安全文件名、自然宽高、`changed`）。
  没有任何标注时 `changed` 为 false，发送入口保持禁用。
- 发送：`ImageEditorComposerTarget.appendImage(output)` 同步返回是否被输入框接收。
  接收方必须是当前聚焦 Composer，并且只能复用既有附件入口（`addAttachmentFiles`），
  让数量上限、大小校验、上传队列与发送协议继续由原链路负责。编辑器不持有上传队列、
  不发送消息、不调用主进程或服务层。
- 目标发现：`registerImageComposerTarget` 由聚焦 Composer 注册；`captureImageComposerTarget`
  在发送点击时同步捕获目标。导出是异步的，捕获后再导出，避免跨会话追加。
  主/辅 pane 可能同时 focused，注册时带上会话/草稿作用域：活跃会话按 `sessionId + workspaceKey`
  匹配，草稿态再比对项目草稿作用域。无匹配时返回 null，绝不退化为写入其它 pane。

## 能力与入口

仅在桌面 / Host 形态（`platform.canOpenLocalFiles === true`）且渲染进程具备 2D canvas
与对象 URL 能力时，预览面板才显示「标注」入口。Web 手机远控默认隐藏，不渲染入口。

## 与上游差异

- 坐标从上游的自然像素改为归一化 0–1，并新增命中测试、整体平移夹取与标注序列化。
- 保存按钮改为「发送到输入框」，输出类型从 `File` 改为可校验的 PNG 字节 payload。
- 事件名、类名、i18n key 与模块元数据均为 NIBI 命名，不保留上游包名、品牌类名或 localStorage key。
- 新增清除全部标注；上游只有逐条撤销与橡皮擦。
