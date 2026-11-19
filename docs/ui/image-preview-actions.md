# 图片预览操作条

## 背景

全屏图片预览（Markdown 图片、消息附件、`node_repl` 工具结果）原先只有下载、编辑、关闭。
手机和桌面都需要在预览层完成“保存到本机 / 打开 / 复制 / 加入对话 / 绘制”，并且所有失败都要有可见反馈。

## 入口与布局

- 操作条位于预览右上角，关闭按钮固定在操作条最右侧。
- 操作条整体避开窗口控件：
  - macOS 桌面下移 48px（`platform-mac-desktop:top-12`）。
  - Windows 桌面使用 `env(titlebar-area-height, 48px)` 高度之下再起一行，并扩大右侧留白，
    不覆盖原生最小化/最大化/关闭按钮。
  - Linux 桌面沿用右上角留白。
- 编辑态（`ImageEditorSurface`）继续使用编辑器自己的控件，不显示预览操作条；视频预览只显示关闭。

## 动作与平台能力

| 动作 | 行为 | 显隐 |
| --- | --- | --- |
| 保存并打开 | 经 `IPlatformService.saveFile` 保存原始字节，再用 `openExternalFile` 打开；两者共用同一份本机副本 | 仅 `canOpenLocalFiles` 且 `saveFile`、`openExternalFile` 都存在时显示；Web 隐藏 |
| 另存为 | 桌面走原生另存为对话框，Web 回退浏览器下载；保留原始格式和文件名后缀 | 有图片源即显示 |
| 复制 | 复用 `copyPreviewImage`，按自然尺寸编码 PNG 写入剪贴板 | 有图片源即显示 |
| 加入对话 | 复用 `registerImageComposerTarget` 的附件 admission，把原始图片文件加入当前会话或草稿输入框；接收方没有 `appendFile` 时回退为 PNG。不发送消息 | 有图片源且已加载时显示；没有可用输入框时提示 |
| 绘制 | 打开既有 `ImageEditorSurface` 标注编辑器 | 仅在既有 `canUseImageEditor` 能力判定通过时显示 |
| 更多 | 下拉菜单重复上述动作，保证窄屏下仍可触达 | 始终显示 |

所有动作按“图片已加载”门禁；视频不显示图片动作。动作使用 `data-image-preview-action` 标记，
便于自动化验证。

## 失败反馈

- 保存/打开失败：`preview.image.actionFailed`；保存下载失败沿用 `markdownImage.downloadFailed`。
- 复制失败：`preview.image.copyFailed`。
- 加入对话失败或输入框拒绝：`preview.image.addFailed`；没有可用输入框：`imageEditor.noComposer`。
- 用户取消保存对话框不提示错误。
- 失败同时写入 `logger.warn`，日志不包含签名 URL 的查询串。

## 验收

- 桌面（Windows/macOS/Linux）：保存并打开可见，保存后调用默认应用打开；复制、加入对话、绘制可用；
  操作条不与 Windows 窗控重叠。
- Web/手机远控：保存并打开隐藏；另存为触发浏览器下载；复制和加入对话可用；绘制按既有能力隐藏。
- 无可用输入框时点击加入对话出现可见提示，不静默。
- 五语言（zh-CN / en-US / ja-JP / ko-KR / ru-RU）显示对应文案。