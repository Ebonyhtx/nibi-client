// 受管 worktree UI 对服务层与共享协议的唯一类型入口。
// 服务契约以 NIBI 的 IManagedWorktreeService 为准，不复制上游 ZCode 类型。
export type {
  IManagedWorktreeService,
  ManagedWorktreeGroup,
  StartManagedWorktreeCreationResult,
} from "@nibi/services";
export type {
  ManagedWorktreeCreation,
  ManagedWorktreeCreationKind,
  ManagedWorktreeCreationPhase,
  ManagedWorktreeCreationSettlement,
  ManagedWorktreeEntry,
  ManagedWorktreeError,
  ManagedWorktreeErrorCode,
  ManagedWorktreeStartRefs,
  ManagedWorktreeTaskRef,
  RemoveManagedWorktreeResult,
} from "@nibi/shared";
