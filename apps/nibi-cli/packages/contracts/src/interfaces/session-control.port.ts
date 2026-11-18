// Session control host port：Node 内核把 8 个会话控制动作收敛到这一条边界。
// Handler 只能经 ToolExecutionContext.sessionControl 访问它，不直接拿 SessionStore 或 runtime 单例。
import type {
  CliSessionControl,
  CliTrustedContext,
  Deadline,
  OperationFeed,
  OperationRef,
  CliSessionRef,
} from "@nibi/session-control/contracts";

/**
 * 工具层看到的窄端口：CLI 8 个动作 + 观察 feed + deadline。
 *
 * `CliSessionControl` 的 8 个方法保持 `(trustedContext, input)` 形态；host 负责把可信上下文
 * 映射到本机 workspace、解析 sessionId、授权、输出复验与幂等。`openOperation` / `createDeadline`
 * 暴露给需要自己驱动等待的调用方，生产适配器内部也复用同一组实现。
 */
export interface SessionControlHost extends CliSessionControl {
  openOperation(
    context: CliTrustedContext,
    operation: OperationRef<CliSessionRef>,
    signal: AbortSignal,
  ): Promise<OperationFeed<CliSessionRef>>;
  createDeadline(timeoutMs: number): Deadline;
}

/**
 * 启动装配注入的可信绑定；工具 JSON 不能选择 surface 或重建调用者。
 * Phase 1 只有 CLI：`kind` 固定为 cli，`context()` 由 Node runtime 用当前会话与 workspace 构造。
 */
export interface SessionControlBinding {
  kind: "cli";
  control: SessionControlHost;
  context(): CliTrustedContext;
}
