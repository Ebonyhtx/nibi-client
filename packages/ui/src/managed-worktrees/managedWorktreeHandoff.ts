// 受管 worktree 创建成功后的首帧交接状态。
//
// 创建记录（Host 内存）在会话启动后立即消失；从 settlement 到会话首份 snapshot
// 之间，主区 pane 没有任何 projection 行，会短暂空白。这里只记录"这个 session 是
// 刚由 worktree 创建流程打开的"，让 pane 在首帧到达前展示一个轻量 loading 提示。
//
// 它不产生会话事实，也不推进任何状态：snapshot 到达、订阅失败或超过展示上限后，
// 提示必须退场，后续仍由既有 projection/错误/重连路径负责。

/** 提示最多展示多久；只约束提示本身，不改变会话订阅状态。 */
export const MANAGED_WORKTREE_HANDOFF_MAX_MS = 30_000;

interface HandoffEntry {
  markedAt: number;
  timer: ReturnType<typeof setTimeout>;
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  // Node 环境下不要让一个 UI 提示计时器拖住进程；浏览器里 timer 是数字。
  const candidate = timer as unknown as { unref?: () => void };
  if (typeof candidate.unref === "function") candidate.unref();
}

/**
 * 只存在于 renderer 内存的交接登记表。key 是 sessionId（CLI 会话全局唯一），
 * 同一 session 重复登记时刷新计时器，不累积第二份状态。
 */
export class ManagedWorktreeHandoffRegistry {
  private readonly entries = new Map<string, HandoffEntry>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly maxAgeMs: number = MANAGED_WORKTREE_HANDOFF_MAX_MS) {}

  mark(sessionId: string): void {
    if (!sessionId) return;
    const existing = this.entries.get(sessionId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => this.settle(sessionId), this.maxAgeMs);
    unrefTimer(timer);
    this.entries.set(sessionId, { markedAt: Date.now(), timer });
    this.notify();
  }

  settle(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.entries.delete(sessionId);
    this.notify();
  }

  isPending(sessionId: string | null | undefined): boolean {
    return Boolean(sessionId && this.entries.has(sessionId));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 测试与宿主卸载时清空，避免计时器或登记跨用例残留。 */
  clear(): void {
    for (const entry of this.entries.values()) clearTimeout(entry.timer);
    this.entries.clear();
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const managedWorktreeHandoffRegistry = new ManagedWorktreeHandoffRegistry();

export function markManagedWorktreeHandoff(sessionId: string): void {
  managedWorktreeHandoffRegistry.mark(sessionId);
}

export type ManagedWorktreeHandoffSubscriptionStatus =
  | "connecting"
  | "live"
  | "error"
  | "closed";

/**
 * 展示条件（纯函数，便于单测）：
 * - 只对刚由 worktree 创建流程打开、且仍登记的 session 生效；
 * - 首份 snapshot 未到（snapshotReady=false）；
 * - 订阅尚未进入 error/closed（错误面板或已释放状态已有自己的 UI）。
 */
export function shouldShowManagedWorktreeHandoff(params: {
  pending: boolean;
  sessionId: string | null;
  snapshotReady: boolean;
  subscriptionStatus: ManagedWorktreeHandoffSubscriptionStatus;
}): boolean {
  return (
    params.pending &&
    params.sessionId !== null &&
    !params.snapshotReady &&
    params.subscriptionStatus !== "error" &&
    params.subscriptionStatus !== "closed"
  );
}
