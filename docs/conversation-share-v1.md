# 会话分享与继续工作 V1

本文描述 NIBI 客户端公开的会话分享协议与只读落地页约定。服务端实现、部署拓扑和运营配置不在本仓库中；客户端只依赖下文列出的 HTTP 接口与响应形状。

## 目标与范围

- 桌面端可以把已完成的 product turn 发布为不可变快照。
- 分享链接可以在浏览器中匿名只读预览，也可以唤起桌面端导入并继续工作。
- 导入在本地 workspace 创建新会话，不会修改原会话，也不会执行模型。
- 手机远控页与普通 Web 页面不提供发布入口。

## 用户流程

```text
Desktop 分享浮窗
  -> 选择已完成的 product turn
  -> prepare（预检、生成上传清单）
  -> upload（逐个产物串行上传）
  -> confirm（提交选择、投影与完整性哈希）
  -> share URL

浏览器预览
  -> GET preview
  -> 只读时间线
  -> public_importable 时展示“在 NIBI 中继续”
  -> nibi://share/import?code=<share_code>

Desktop 导入
  -> continuation（可选登录态）
  -> 下载并校验产物
  -> 原子写入 <workspace>/.zcode-share/<share-id>/
  -> 新建会话 + shared_context
```

## 权限模式

| 模式 | 匿名预览 | 导入 |
| --- | --- | --- |
| `private` | 否，owner 登录后才可预览 | 仅 owner |
| `public_readonly` | 是 | 否 |
| `public_importable` | 是 | 是 |

服务端返回的 `authentication_required`、`not_found` 与权限错误必须按稳定错误类型展示，不得通过错误文本推断分享是否存在或 owner 身份。

## 接口形状

客户端与服务端之间的稳定接口：

- `prepare`：提交标题、权限、选择与投影，返回预检问题、上传清单与能力。
- `upload`：上传产物字节，返回 `safety_status`；客户端不按该字段分支。
- `confirm`：提交 `selected_product_turn_ids`、`projection.rows`、两哈希与披露确认。
- `preview`：匿名读取公开投影与产物下载地址。
- `continuation`：导入端读取投影并取得最终导入许可。

完整性只校验服务端原样返回的 `projection_sha256` 与 `artifact_set_sha256`，不对客户端重新序列化的对象计算哈希。

## 安全边界

- Deep link 只携带 share code；JWT、Signed URL、Rows 正文和文件内容不进入日志。
- 公开页把发布者可控的正文当作不可信内容：远程图片语法降级为普通链接，CSP 的 `img-src` 只允许 `'self' data: blob:`。
- 分享页需要 `script-src 'wasm-unsafe-eval'` 以支持代码高亮的 WebAssembly；`eval` 与 `new Function` 仍然禁止。
- 导入产物只写入 `<workspace>/.zcode-share/<share-id>/shared-artifacts/`，路径必须经过 containment 校验；缺失或非法路径退回只读展示。
- 上传前校验 size、MIME 与 SHA-256；下载前检查 `Content-Length`，不得把超过 manifest 声明的响应读入内存。
- 失败时不得留下半个分享、半个 artifact 目录或半个会话。

## 跨版本兼容

分享数据在发布端、服务端、落地页与导入端之间流动，四者可以独立升级。规则：

1. **入站宽容、出站严格。** 入站 schema 允许未知字段；出站 schema 使用 strict，多带字段视为本端 bug。
2. **完整性只对服务端原样字节校验**，不对解析产物重算。
3. **rows 只做 additive 演进。** 新字段必须 optional；不删字段、不收窄枚举、不改字段语义。
4. **新增 row kind 时，老客户端会跳过该行。** 跳过之后分享仍须自洽。
5. **`schema_version` 只在不可跳过的破坏性变化时递增。** 版本高于本端认知时返回 `unsupported_schema_version`，不要混入 `invalid_contract`。

## 代码位置

- 投影与兼容解析：`packages/shared/src/conversationShare*`
- 发布与导入服务：`packages/services/src/conversationShare*`
- 桌面分享浮窗与选择面板：`packages/ui/src/conversation-share-interaction/`
- 只读时间线与落地页：`packages/ui/src/v4/conversationShare*`、`packages/web-share/`

## 验收要点

- private / public_readonly / public_importable 三种权限的预览与导入行为。
- 运行中 turn 不可选；预检与发布复用同一套校验。
- 产物篡改、缺失、超限、类型不支持时的稳定错误与可重试性。
- 桌面、手机窄屏、深浅主题与中英文布局。
- 旧版本分享在新客户端可读；新版本分享在旧客户端返回稳定升级提示。
