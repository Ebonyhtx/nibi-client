# App-exclusive 会话控制

Host 侧承接桌面 `app-server` 的 4 个 App 独占工具：`ListProjects`、`OpenSession`、
`SetSessionArchived`、`SetSessionPinned`。模型面 schema 由 `@nibi/session-control`
提供，本模块不复制第二份工具定义。

- 身份与范围只由 Host 的客户端归属、任务归属与项目树派生；模型输入不能提供
  `callerSessionId`、`sourceServerId`、`allowedScopes` 或 UI target。
- 反向方法名是封闭集合：`appControl/listProjects`、`appControl/openSession`、
  `appControl/setSessionArchived`、`appControl/setSessionPinned`、`appControl/cancel`。
- 归档/置顶以 tasks-index 为权威，只改任务行，不中断执行、不改内核会话库。
- `OpenSession` 只向 Renderer 投递显式打开事件，不自行导航、不抬升 OS 窗口；没有
  订阅者或超时返回 `unavailable`，不回退到别的入口。
- 目标不在可信范围、已删除、工作区不匹配或连接代次变化时一律 `forbidden`；
  端口缺席时内核不注册这 4 个工具，误调用按 `unavailable` 失败。