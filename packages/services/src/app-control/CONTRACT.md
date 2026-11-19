# App-exclusive 会话控制

Host 侧承接桌面 `app-server` 的 4 个 App 独占工具：`ListProjects`、`OpenSession`、
`SetSessionArchived`、`SetSessionPinned`。模型面 schema 由 `@nibi/session-control`
提供，本模块不复制第二份工具定义。

- 身份与范围只由 Host 的客户端归属、任务归属与项目树派生；模型输入不能提供
  `callerSessionId`、`sourceServerId`、`allowedScopes` 或 UI target。
- 反向方法名是封闭集合：`appControl/listProjects`、`appControl/openSession`、
  `appControl/setSessionArchived`、`appControl/setSessionPinned`、`appControl/sessionArchived`、
  `appControl/cancel`。`sessionArchived` 是内部只读查询，只给 CLI fork 提供任务索引的归档事实；
  未知目标仍按 `forbidden` 拒绝，来源不可确认时省略 `archived`（不伪造「未归档」）。
- 归档/置顶以 tasks-index 为权威，只改任务行，不中断执行、不改内核会话库。
- `sourceServerId` 是归属真值：Source Host 只把自己目录里的会话标成该来源，并拒绝任何
  其他来源的目标（`forbidden: Session source does not match this Host`），不跨来源搜索；
  桌面聚合 Host（无 `sourceServerId`）可发现已连接远端，但归档/置顶必须经窗口 Controller
  路由到 owning host。owning host 不可达时按 `unavailable` 失败，绝不先写本地索引。
- `OpenSession` 只向 Renderer 投递显式打开事件，不自行导航、不抬升 OS 窗口；没有
  订阅者或超时返回 `unavailable`，不回退到别的入口。已归档目标不在当前导航投影内，
  返回 `{status:"unavailable", reason:"project.task-not-found"}`，不自动取消归档。
- 目标不在可信范围、已删除、工作区不匹配或连接代次变化时一律 `forbidden`；
  端口缺席时内核不注册这 4 个工具，误调用按 `unavailable` 失败。