# 会话工具展示

UI 模块负责 ListSessions、ReadSession、CreateSession、ForkSession、SendToSession、
WaitSessions、InterruptSession、RenameSession 的摘要与详情。外部通过 `contract.ts`
选择 renderer；输入沿用 `ToolCallBlockRenderContext`。

- tool call 是唯一数据源：不缓存跨会话标题、不发起额外服务查询、不复制业务状态。
- 工具失败优先；admission、delivery 与 wait 状态分别表达，不由 completed 推断目标任务成功。
- 字段缺失只展示已知信息；不输出内部路由或整包 JSON。消息原文保留，截断必须显式标注。
- `ToolLayout` 持有折叠状态；会话卡自身只保留展示状态，快照加载沿用注入回调。
- 只读工具（ListSessions / ReadSession / WaitSessions）不渲染任何变更入口。
- 未知结果形状回退到通用 `FallbackToolCallBlock`，不猜测字段语义。