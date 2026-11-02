# desktop-workspace-open-confirm

一页以内。只写类型与测试表达不了的三样：模块存在的意图、不变量、与其它模块的交集在哪个 hook 点处理。

## 意图

外部 `nibi://workspace/open?path=...` 的确认窗。上游原实现是 Windows 原生 TaskDialog；这里用
main 直接持有的无边框静态页替代“运行中”的呈现，保持同一安全边界，但视觉与 NIBI 一致。

## 不变量

- **确认先于探测**：调用方必须在 `statSync`/`handleOpenWorkspacePath` 之前完成确认；取消即不打开。
- **branding 不能授权**：页面只加载 `out/renderer/workspace-open-confirm.html`，数据经
  `additionalArguments` 传入，决定经独立 IPC 回传；页面内容无法伪造“已确认”。
- **三种返回**：`true` 明确确认、`false` 取消/关闭、`undefined` 品牌化窗不可用；调用方对
  `undefined` 必须回退原生 `confirmExternalWorkspaceOpen`，不得直接打开。
- **默认安全**：取消按钮默认聚焦；Esc/关闭按钮/窗口销毁都按取消处理；并发请求不叠窗。
- **冷启动走原生**：首次窗口 bootstrap 早于 renderer ready，仍由原生同步确认；本模块只服务运行中。

## 与其它模块的交集

- 入口：`desktopOAuthDeepLink.ts` 的 workspace 分支（`nibi://workspace/open`）。
- 原生兜底：同文件的 `confirmExternalWorkspaceOpen`（冷启动/加载失败/IPC 异常共用）。
- 静态页：`src/renderer/workspace-open-confirm.html`（Vite entry）；preload 在
  `src/preload/workspace-open-confirm/index.ts`。
