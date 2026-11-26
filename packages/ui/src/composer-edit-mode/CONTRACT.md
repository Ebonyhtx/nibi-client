# 编辑态 Composer（composer-edit-mode）

把「编辑历史用户消息 / 队列消息」从行内编辑器搬到主 Composer。本模块只负责编辑态身份、
scope、失效裁决与目标切换；命令派发、草稿持久化和 U36 队列锁仍由宿主持有。

## 不变量

- 编辑草稿只存在 renderer 内存：`composerEditScopeId()` 带 `composer-edit:` 前缀，
  `composerDraftStore` 对该前缀的读/写/清一律不落 localStorage。
- `originalDraft` 在编辑期间不可变；取消或切换目标只丢弃编辑副本，原会话草稿原样恢复。
- `opening` 阶段没有正文：队列项必须先等到 `lockQueueItemEdit` accepted/duplicate，
  才切 Composer scope；等待期间切换目标会释放迟到的锁。
- 提交路由唯一：user query → `editUserQuery`，queue item → `editQueueItem`，队列项成功
  或失败都调用幂等 `releaseQueueItemEdit`。模块不新增协议字段、不直连内核。
- 投影是失效的唯一事实源：`notLatest`（目标 user query 不再 canEdit）、
  `queueItemRemoved`（队列项消失）、`editLockLost`（曾观察到本端锁后锁消失/换主）。
  失效不自动丢正文，用户显式取消。
- 切换目标时若正文已改，先确认丢弃，再释放旧目标（队列锁），最后进入新目标。
- 提交成功由 Composer 的 `onSubmissionSettled` 通知结束 scope；失败保持编辑态，
  可重试或取消。

## 与其它模块的交集

- `SessionPane`：持有 hook，注入队列锁端口与提交端口；把 `draftScopeId/editBar/
editFocusRequest/editSubmitRequest/onSubmissionSettled` 传给 Composer。
- `ConversationComposer`：编辑 scope 下草稿不持久化；bar 作为编辑器卡片的头带渲染在
  正文上方（与正文/工具栏同一圆角容器），不是 composer 之外的一条独立面板；rewind
  通过 `editSubmitRequest(workspaceMode: "rewind")` 回到同一条提交路径。
- `ConversationRowView`：编辑按钮只发 begin 意图；当前编辑目标行显示 “Editing below”，
  不再挂载行内 `ChatPromptEditor`。旧行内路径由 `ENABLE_COMPOSER_EDIT_MODE=false` 保留。
- `ConversationQueuePanel`：沿用 U36 `lockQueueItemEdit` 投影；本模块只消费锁状态。
