# managed-worktree-tasks

受管 worktree 的任务编排服务（RPC 通道 `managed-worktrees`），语义对齐上游 ZCode 3.18.2。
仅本地桌面 Host；手机 attachment 不放行该通道。

- 唯一事实源：worktree 是否存在以 `git worktree list` + 受管布局为准；"使用它的任务"按 tasks-index
  `worktree_root` 精确匹配；创建记录与删除租约只在本服务内存中。
- `startNewTask` / `forkToWorktree`：创建记录驱动创建视图；worktree 建好后预留任务行（workspace = 项目，
  cwd 与 `worktree_root` 写一次，附加目录按源仓库内 root 映射），再以 Host 可信身份向项目 CLI 发送带
  `cwd` / `targetCwd` 的命令。fork 带入父任务 cwd 的未提交改动。
- `removeWorktree`：先同步取得删除租约（`removal-gate.ts`），再检查任务、终端；等待租约之前已通过闸门的
  全部会话操作结束后，请求项目 CLI `session/releaseUnderDirectory` 卸载 cwd 位于 worktree 内的全部驻留
  会话（会话选择与忙闲以 CLI 为准）。忙或卸载失败时中止删除；最后执行 `git worktree remove` 并释放租约。
- `dismissCreation` / `continueWithoutWorktree`：先按最后一次发出的命令向 CLI 查询（`commands/query`）；
  已执行则按"会话已启动"结束，不删除。否则撤销尚无 CLI 事实的预留行再删除残留 worktree。
- `reaper.ts`：Host 启动时回收崩溃遗留的受管 worktree（无任务占用、git 未登记的 bucket 目录）；
  已登记但目录缺失的条目交给 `git worktree prune`。
- 文件划分：`service.ts` 创建流程与对外接口；`removal.ts` 删除流程与"请 CLI 卸载目录内会话"；
  `removal-gate.ts` 删除租约与会话操作闸门；`ports.ts` 注入端口；`reaper.ts` 启动期孤儿回收。
- 所有外部副作用经 `ManagedWorktreeServicePorts`（`ports.ts`）注入，由 Host 装配。