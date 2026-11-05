// task/bot 读路径的 v4 帧投影：旧 `session/subscribe` 在内核里不存在时（Rust），
// 把 `conversation/<sessionId>` 的 row 增量翻译成 bot 消费的 `ZCodeStreamEvent` 子集。
//
// 为什么需要这一层：Rust 内核不投影 legacy `session/event`，`onDynamicTaskEvent` 过去只有
// 一个订阅源，群机器人的 IM 回复（agent_message_chunk → task_complete flush）因此静默。
// 投影只覆盖 bot 真正消费的事件（运行开始、正文/思考增量、工具卡、终态），不做完整 UI 时间线。
//
// 触发条件严格：只有 `onDynamicSessionEvent` 收到 -32601 才启动，Node 内核不会同时出现两条流。
import {
  TopicWireFrameAssembler,
  conversationTopicFrameSchema,
  type ConversationRow,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type ConversationTopicWireCandidate,
} from "@nibi/shared/nibi-protocol-v4";
import { generateTraceId, type ZCodeStreamEvent } from "@nibi/shared";
import type { IZCodeAgentService, ZCodeAgentSessionTarget } from "./zcodeAgent.js";

type ToolStreamStatus = "pending" | "in_progress" | "completed" | "failed" | "denied" | "stopped";

export interface V4TaskStreamSinkOptions {
  agent: Pick<
    IZCodeAgentService,
    "subscribeConversationV4" | "unsubscribeConversationV4" | "onDynamicConversationFrame"
  >;
  target: ZCodeAgentSessionTarget;
  /** 订阅/解码失败时的 warn（不抛：读路径降级不能影响任务本身）。 */
  warn?: (message: string, error?: unknown) => void;
}

/**
 * 一个 task 的共享投影源：多个订阅者（bot、host 镜像）共用一个 v4 订阅。
 * `activate()` 由 legacy 订阅的 -32601 回调触发，之后才开始接收帧。
 */
export class V4TaskStreamSink {
  private readonly listeners = new Set<(event: ZCodeStreamEvent) => void>();
  private readonly assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
  private early: ConversationTopicWireCandidate[] = [];
  private subscriptionId: string | undefined;
  private frameListener: { dispose(): void } | undefined;
  private started = false;
  private disposed = false;

  private activeInputId: string | undefined;
  private activeTurnRowId: number | undefined;
  private readonly assistantLen = new Map<number, number>();
  private readonly reasoningLen = new Map<number, number>();
  private readonly toolStatus = new Map<string, ToolStreamStatus>();
  private readonly toolCallEmitted = new Set<string>();
  private readonly startedInputs = new Set<string>();
  private readonly terminalTurns = new Set<number>();

  constructor(private readonly options: V4TaskStreamSinkOptions) {}

  addListener(listener: (event: ZCodeStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** legacy 订阅不可用时由订阅方调用；重复调用无副作用。 */
  activate(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.frameListener = this.options.agent.onDynamicConversationFrame(this.options.target)(
      (wire) => this.accept(wire),
    );
    void this.subscribe();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.frameListener?.dispose();
    this.frameListener = undefined;
    const subscriptionId = this.subscriptionId;
    this.subscriptionId = undefined;
    if (subscriptionId) {
      void this.options.agent
        .unsubscribeConversationV4({ ...this.options.target, subscriptionId })
        .catch(() => undefined);
    }
  }

  private async subscribe(): Promise<void> {
    try {
      const result = await this.options.agent.subscribeConversationV4({
        ...this.options.target,
        visibility: "background",
      });
      if (this.disposed) {
        void this.options.agent
          .unsubscribeConversationV4({
            ...this.options.target,
            subscriptionId: result.ack.subscriptionId,
          })
          .catch(() => undefined);
        return;
      }
      this.subscriptionId = result.ack.subscriptionId;
      for (const wire of this.early.splice(0)) this.accept(wire);
    } catch (error) {
      this.options.warn?.("v4 task stream subscribe failed", error);
    }
  }

  private accept(wire: ConversationTopicWireCandidate): void {
    if (this.disposed) return;
    if (wire.topic !== `conversation/${this.options.target.sessionId}`) return;
    if (!this.subscriptionId) {
      if (this.early.length < 128) this.early.push(wire);
      return;
    }
    if (wire.subscriptionId !== this.subscriptionId) return;
    for (const event of this.assembler.accept(wire)) {
      if (event.kind === "fault") {
        this.options.warn?.(`v4 task stream fault: ${event.fault.reasonCode}`);
        continue;
      }
      this.acceptFrame(event.frame);
    }
  }

  private acceptFrame(frame: ConversationTopicFrame): void {
    if (frame.payload.kind === "snapshot") {
      this.seed(frame.payload.snapshot);
      return;
    }
    for (const delta of frame.payload.deltas) {
      switch (delta.op) {
        case "row.appended":
        case "row.upserted":
          this.acceptRow(delta.row);
          break;
        case "row.delta":
          this.appendDelta(delta.rowId, delta.path, delta.append);
          break;
        case "row.removed":
          this.forgetRowsFrom(delta.fromRowId);
          break;
        case "state.updated":
          break;
        // workflowRun.* 与 conversation 正文无关
        default:
          break;
      }
    }
  }

  private seed(snapshot: ConversationSnapshot): void {
    const rows = snapshot.rows.window;
    let activeIndex = -1;
    // 只投影“最后一个仍在运行的 turn”：历史轮次的正文不该被机器人当成新回复发出去。
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      if (row.kind !== "turnHeader") continue;
      if (row.state === "running") activeIndex = index;
      break;
    }
    if (activeIndex < 0) return;
    const header = rows[activeIndex]!;
    if (header.kind !== "turnHeader") return;
    this.activeTurnRowId = header.rowId;
    this.activeInputId = header.sourceCommandId ?? this.findInputIdBefore(rows, activeIndex);
    this.emitRunStarted(this.activeInputId);
    for (let index = activeIndex + 1; index < rows.length; index += 1) {
      this.acceptRow(rows[index]!);
    }
  }

  private findInputIdBefore(rows: readonly ConversationRow[], before: number): string | undefined {
    for (let index = before - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      if (row.kind === "userInput" && row.sourceCommandId) return row.sourceCommandId;
    }
    return undefined;
  }

  private acceptRow(row: ConversationRow): void {
    switch (row.kind) {
      case "turnHeader":
        if (row.state === "running") {
          this.activeTurnRowId = row.rowId;
          this.activeInputId = row.sourceCommandId ?? this.activeInputId;
          this.emitRunStarted(this.activeInputId);
          return;
        }
        this.finishTurn(row.rowId, row.sourceCommandId ?? this.activeInputId, row.state);
        return;
      case "userInput":
        if (row.origin === "realUser" && row.sourceCommandId) {
          this.activeInputId = row.sourceCommandId;
          this.emitRunStarted(row.sourceCommandId);
        }
        return;
      case "assistantText":
        this.appendText("agent_message_chunk", this.assistantLen, row.rowId, row.text);
        return;
      case "reasoning":
        this.appendText("agent_thought_chunk", this.reasoningLen, row.rowId, row.text);
        return;
      case "toolCall":
        this.acceptToolCall(row);
        return;
      default:
        return;
    }
  }

  private appendDelta(rowId: number, path: string, append: string): void {
    if (path === "text") {
      // row.delta 只允许作用于流式行，但直接按 rowId 增量记账即可；
      // 正文/思考共用 "text"，以哪个 map 里有这个 rowId 为准。
      if (this.reasoningLen.has(rowId) && !this.assistantLen.has(rowId)) {
        this.reasoningLen.set(rowId, (this.reasoningLen.get(rowId) ?? 0) + append.length);
        this.emitChunk("agent_thought_chunk", append, rowId);
        return;
      }
      this.assistantLen.set(rowId, (this.assistantLen.get(rowId) ?? 0) + append.length);
      this.emitChunk("agent_message_chunk", append, rowId);
    }
  }

  private appendText(
    type: "agent_message_chunk" | "agent_thought_chunk",
    lengths: Map<number, number>,
    rowId: number,
    text: string,
  ): void {
    const previous = lengths.get(rowId) ?? 0;
    lengths.set(rowId, text.length);
    if (text.length > previous) {
      this.emitChunk(type, text.slice(previous), rowId);
    }
  }

  private emitChunk(
    type: "agent_message_chunk" | "agent_thought_chunk",
    content: string,
    rowId: number,
  ): void {
    if (!content) return;
    const inputId = this.activeInputId;
    this.emit({
      type,
      taskId: this.options.target.sessionId,
      traceId: inputId ?? generateTraceId(this.options.target.sessionId),
      ...(inputId ? { inputId } : {}),
      content,
      ...(type === "agent_message_chunk" ? { messageId: `row-${rowId}` } : {}),
    });
  }

  private emitRunStarted(inputId: string | undefined): void {
    const key = inputId ?? "unknown";
    if (this.startedInputs.has(key)) return;
    this.startedInputs.add(key);
    this.emit({
      type: "task_run_started",
      taskId: this.options.target.sessionId,
      traceId: inputId ?? generateTraceId(this.options.target.sessionId),
      ...(inputId ? { inputId } : {}),
      startedAt: Date.now(),
    });
  }

  private finishTurn(rowId: number, inputId: string | undefined, state: string): void {
    if (this.terminalTurns.has(rowId)) return;
    this.terminalTurns.add(rowId);
    const traceId = inputId ?? generateTraceId(this.options.target.sessionId);
    if (state === "failed") {
      this.emit({
        type: "task_error",
        taskId: this.options.target.sessionId,
        traceId,
        ...(inputId ? { inputId } : {}),
        error: "NIBI session failed",
        code: "turn_failed",
      });
      return;
    }
    this.emit({
      type: "task_complete",
      taskId: this.options.target.sessionId,
      traceId,
      ...(inputId ? { inputId } : {}),
      stopReason: state === "completedInterrupted" ? "interrupted" : "complete",
    });
  }

  private acceptToolCall(row: Extract<ConversationRow, { kind: "toolCall" }>): void {
    const status = mapToolStatus(row.status);
    const previous = this.toolStatus.get(row.toolCallId);
    this.toolStatus.set(row.toolCallId, status);
    const inputId = this.activeInputId;
    const traceId = inputId ?? generateTraceId(this.options.target.sessionId);
    if (!this.toolCallEmitted.has(row.toolCallId)) {
      this.toolCallEmitted.add(row.toolCallId);
      this.emit({
        type: "tool_call",
        taskId: this.options.target.sessionId,
        traceId,
        ...(inputId ? { inputId } : {}),
        toolId: row.toolCallId,
        toolName: row.toolName,
        kind: row.toolName,
        title: row.toolName,
        input: row.input ?? row.inputText,
        raw: row,
      });
      return;
    }
    if (previous === status) return;
    this.emit({
      type: "tool_call_update",
      taskId: this.options.target.sessionId,
      traceId,
      ...(inputId ? { inputId } : {}),
      toolId: row.toolCallId,
      toolName: row.toolName,
      kind: row.toolName,
      status,
      ...(row.input !== undefined ? { input: row.input } : {}),
      ...(row.output?.text ? { content: row.output.text } : {}),
      ...(row.error?.message ? { error: row.error.message } : {}),
      raw: row,
    });
  }

  private forgetRowsFrom(fromRowId: number): void {
    for (const rowId of this.assistantLen.keys()) {
      if (rowId >= fromRowId) this.assistantLen.delete(rowId);
    }
    for (const rowId of this.reasoningLen.keys()) {
      if (rowId >= fromRowId) this.reasoningLen.delete(rowId);
    }
    if (this.activeTurnRowId !== undefined && this.activeTurnRowId >= fromRowId) {
      this.activeTurnRowId = undefined;
    }
  }

  private emit(event: ZCodeStreamEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function mapToolStatus(status: string): ToolStreamStatus {
  switch (status) {
    case "inputStreaming":
    case "pendingApproval":
      return "pending";
    case "running":
      return "in_progress";
    case "success":
      return "completed";
    case "error":
      return "failed";
    case "cancelled":
      return "stopped";
    default:
      return "in_progress";
  }
}
