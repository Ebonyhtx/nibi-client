import { createWorktreeRemovalGate, type WorktreeRemovalGate } from "./index.js";

/**
 * 契约示例：删除受管 worktree 前先取得删除租约，等已登记的会话操作结束，再执行删除。
 * 取得租约失败说明同目录已有删除在进行，调用方应把它当成可重试的忙状态。
 */
export async function removeManagedWorktreeWithLease(input: {
  gate: WorktreeRemovalGate;
  worktreeRoot: string;
  remove: () => Promise<void>;
}): Promise<boolean> {
  if (!input.gate.acquire(input.worktreeRoot)) return false;
  try {
    await input.gate.settle();
    await input.remove();
    return true;
  } finally {
    input.gate.release(input.worktreeRoot);
  }
}

export function createRemovalGateForExample(): WorktreeRemovalGate {
  return createWorktreeRemovalGate();
}
