// task/bot 读路径的 v4 帧投影：旧 `session/subscribe` 在内核里不存在时（Rust），
// 把 `conversation/<sessionId>` 的 row/state 增量翻译成 bot 消费的 `ZCodeStreamEvent` 子集。
//
// 为什么需要这一层：Rust 内核不投影 legacy `session/event`，`onDynamicTaskEvent` 过去只有
// 一个订阅源，群机器人的 IM 回复（agent_message_chunk → task_complete flush）因此静默。
//
// 投影面（= `botsService.handleStreamEvent` 与 host 镜像真正消费的事件）：
//   - 行：运行开始、正文/思考增量、工具卡、终态；
//   - `pendingInteractions`：权限与提问（AskUserQuestion / ExitPlanMode）。缺了它群任务会
//     永远卡在等待确认——这是 Rust 下最致命的一处读路径空洞；
//   - `config`：模型/思考档/模式（bot 的 /model /think /mode 与 UI 工具栏都读它）；
//   - `usage`：上下文用量（UI 比例条与手机端）；
//   - `meta`：会话标题；
//   - `plan`：TodoWrite 步骤（顶部计划面板）。
//
// 触发条件严格：只有 `onDynamicSessionEvent` 收到 -32601 才启动，Node 内核不会同时出现两条流。
import {
  TopicWireFrameAssembler,
  conversationTopicFrameSchema,
  type ConversationRow,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type ConversationTopicWireCandidate,
  type PendingInteraction,
  type SessionConfigState,
  type SessionMetaState,
  type SessionUsageState,
  type StatePatch,
} from "@nibi/shared/nibi-protocol-v4";
import {
  extractPlanStepsFromToolInput,
  extractPlanStepsFromToolOutput,
  formatModelPickerValue,
  generateTraceId,
  getZCodeAgentAvailableModes,
  normalizeAvailableZCodeMode,
  type ModelSelection,
  type ZCodeConfigOption,
  type ZCodePermissionOption,
  type ZCodePlanStep as PlanStep,
  type ZCodeStreamEvent,
} from "@nibi/shared";
import type { IZCodeAgentService, ZCodeAgentSessionTarget } from "./zcodeAgent.js";

type ToolStreamStatus = "pending" | "in_progress" | "completed" | "failed" | "denied" | "stopped";

export interface V4TaskStreamSinkOptions {
  agent: Pick<
    IZCodeAgentService,
    "subscribeConversationV4" | "unsubscribeConversationV4" | "onDynamicConversationFrame"
  >;
  target: ZCodeAgentSessionTarget;
  /**
   * 每个投影事件同时投给全局 task 事件源（`onDynamicStreamEvent`）。
   *
   * 全局源与 listener 是两个不同的订阅面：listener 是 `onDynamicTaskEvent(params)`
   * 那种带 workspace 身份的订阅（bot 主路径），全局源是 `onDynamicStreamEvent(taskId)`
   * （bot 在 taskService 没有 `onDynamicTaskEvent` 时的 fallback，以及 Host 间镜像）。
   * 只投 listener 会让后者在 Rust 内核下一个事件都收不到。
   */
  publishGlobal?: (event: ZCodeStreamEvent) => void;
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

  /** 上一次投影出去的 pendingInteractions 身份，用于只在增删时发事件（不重发同一条）。 */
  private pendingInteractionIds = new Set<string>();
  /** 已经发过请求事件、还没被回答的交互（重发 patch 时跳过）。 */
  private readonly announcedInteractions = new Set<string>();
  /** 已发过 permission_request 的交互，用来决定「消失」时发 permission_response 还是 elicitation_response。 */
  private readonly permissionInteractions = new Set<string>();
  /** 上一次投影出去的 config，用于抑制无变化的重复事件。 */
  private lastConfig: SessionConfigState | undefined;
  /** 上一次投影出去的 usage 值，用于抑制无变化的重复事件。 */
  private lastUsage: SessionUsageState | undefined;
  private lastTitle: string | undefined;
  /** 上一次投影出去的 plan 步骤指纹，用于抑制无变化的重复事件。 */
  private lastPlanFingerprint: string | undefined;
  /** 工具输入里的 TodoWrite 计划：终态输出到达前先用它点亮顶部计划面板。 */
  private readonly toolPlanFingerprint = new Map<string, string>();
  /** 上一次投影出去的 queue 项（sourceCommandId），用于识别「被移除」。 */
  private queuedInputIds = new Set<string>();
  /**
   * 已从队列消失、但还没判定是「开跑了」还是「被丢弃」的输入。
   *
   * Rust 内核不发 legacy `turn.steerDropped`：队列项被删（deleteQueueItem）、
   * 插话被丢掉（Fate::Dropped）、或运行时重启后队列不持久化，都只表现为
   * `queue` 状态少了一项。判定靠顺序：内核先 `emit_queue` 再 `TurnStarted`，
   * 所以下一次回合开始时，同 id = drained，其余 = discarded。
   */
  private readonly unresolvedQueueRemovals = new Set<string>();

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
          this.acceptState(delta.patch);
          break;
        // workflowRun.* 与 conversation 正文无关
        default:
          break;
      }
    }
  }

  private seed(snapshot: ConversationSnapshot): void {
    // 状态面先播：即便没有运行中的回合（冷恢复的历史会话），标题/用量/计划/待答交互
    // 也必须让订阅方看到——否则群机器人重启后看不到已经挂着的权限请求。
    this.acceptState({
      config: snapshot.config,
      usage: snapshot.usage,
      meta: snapshot.meta,
      plan: snapshot.plan,
      pendingInteractions: snapshot.pendingInteractions,
    });

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

  /**
   * `state.updated` 是**键级整体替换**（不是深合并），所以每个在场的键都按完整值投影。
   * 只处理读路径消费的键；`control`/`availability`/`queue` 等由 UI 的 v4 store 直接读，
   * 不在这条 legacy 词表里重复一份。
   */
  private acceptState(patch: StatePatch): void {
    if (patch.pendingInteractions) this.projectPendingInteractions(patch.pendingInteractions);
    if (patch.config) this.projectConfig(patch.config);
    if (patch.usage) this.projectUsage(patch.usage);
    if (patch.meta) this.projectMeta(patch.meta);
    if (patch.plan !== undefined) this.projectPlan(patch.plan);
    if (patch.queue) this.projectQueue(patch.queue.items);
  }

  /**
   * 队列项消失 = 开跑或被丢弃。内核的 `queue` 状态是唯一事实源（它不发 legacy 的
   * `turn.steerDropped`），所以这里只记录「谁消失了」，等下一次回合开始再裁决：
   * 同 id 开跑 = drained，其余 = discarded。bot 靠这个把群输入表情从「等待」收口。
   */
  private projectQueue(items: readonly { sourceCommandId: string }[]): void {
    const next = new Set(items.map((item) => item.sourceCommandId));
    for (const id of this.queuedInputIds) {
      if (!next.has(id)) this.unresolvedQueueRemovals.add(id);
    }
    this.queuedInputIds = next;
  }

  /** 回合开始时裁决上一批队列移除：开跑的那一项算 drained，其余算被丢弃。 */
  private settleQueueRemovals(startedInputId: string | undefined): void {
    if (this.unresolvedQueueRemovals.size === 0) return;
    const drained = startedInputId && this.unresolvedQueueRemovals.has(startedInputId);
    const discarded = [...this.unresolvedQueueRemovals].filter((id) => id !== startedInputId);
    this.unresolvedQueueRemovals.clear();
    if (drained) {
      this.emitQueueStatus("drained", [startedInputId]);
    }
    if (discarded.length > 0) {
      this.emitQueueStatus("discarded", discarded);
    }
  }

  private emitQueueStatus(
    status: "drained" | "discarded",
    pendingInputIds: string[],
  ): void {
    // 刻意不带 inputId：这条状态说的是「上一批排队输入」，不是当前回合的输入。
    // 带上新回合的 inputId 会让 bot 的私聊归属过滤把它当成别的轮次而丢掉。
    this.emit({
      type: "turn_steer_status",
      taskId: this.options.target.sessionId,
      traceId: generateTraceId(this.options.target.sessionId),
      status,
      pendingInputIds,
      // 不带 reason：内核不区分「用户删了」和「插话被丢」，两者都是「移除/拒绝」，
      // 正好对应 bot 的非 session_resumed 文案。编一个 session_resumed 会谎报重启。
    });
  }

  private projectPendingInteractions(pending: readonly PendingInteraction[]): void {
    const next = new Set(pending.map((interaction) => interaction.interactionId));
    // 已消失的交互 = 被回答/取消：发对应的 response 事件，让 bot 收起卡片、UI 清弹窗。
    for (const interactionId of this.pendingInteractionIds) {
      if (next.has(interactionId)) continue;
      this.emitInteractionResolved(interactionId);
    }
    this.pendingInteractionIds = next;
    for (const interaction of pending) {
      // 同一个 interactionId 只发一次请求事件；后续 patch 重复携带它是常态。
      if (this.announcedInteractions.has(interaction.interactionId)) continue;
      this.announcedInteractions.add(interaction.interactionId);
      this.emitInteractionRequest(interaction);
    }
  }

  private emitInteractionRequest(interaction: PendingInteraction): void {
    const traceId = this.activeInputId ?? generateTraceId(this.options.target.sessionId);
    const base = {
      taskId: this.options.target.sessionId,
      traceId,
      ...(this.activeInputId ? { inputId: this.activeInputId } : {}),
      requestId: interaction.interactionId,
    };
    if (interaction.payload.kind === "permission") {
      const payload = interaction.payload;
      this.permissionInteractions.add(interaction.interactionId);
      this.emit({
        ...base,
        type: "permission_request",
        description: payload.summary,
        kind: payload.toolName,
        title: payload.toolName,
        options: permissionOptionsFromPayload(payload.options, payload.fullAccessOption),
        ...(payload.freeText ? { freeText: true } : {}),
        ...(payload.origin ? { origin: payload.origin } : {}),
        raw: interaction,
      });
      return;
    }
    if (interaction.payload.kind === "userInput") {
      const payload = interaction.payload;
      const questions = (payload.questions ?? []).map((question) => ({
        question: question.question,
        header: question.header,
        options: question.options.map((option) => ({
          value: option.value,
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
        })),
        ...(question.multiSelect ? { multiSelect: true } : {}),
      }));
      const first = questions[0];
      this.emit({
        ...base,
        type: "elicitation_request",
        message: first?.question ?? payload.prompt,
        ...(first?.header ? { header: first.header } : {}),
        options: first?.options ?? [],
        ...(first?.multiSelect ? { multiSelect: true } : {}),
        ...(questions.length > 0 ? { questions } : {}),
        ...(payload.origin ? { origin: payload.origin } : {}),
        ...(payload.schema !== undefined ? { schema: payload.schema } : {}),
      });
      return;
    }
    // workspaceHookReview 不是 bot/镜像的交互面（工作区级软门禁由 UI 的 v4 store 处理）。
  }

  private emitInteractionResolved(interactionId: string): void {
    this.announcedInteractions.delete(interactionId);
    // 权限：没有任何消费方读 `permission_response`（bot / UI / 手机端都只读 request），
    // 而 v4 的 `pendingInteractions` 消失并不告诉我们用户选了 allow 还是 deny。
    // 编一个 decision 只会制造假事实，所以这里不发事件。
    if (this.permissionInteractions.delete(interactionId)) return;
    const traceId = this.activeInputId ?? generateTraceId(this.options.target.sessionId);
    // 提问：bot 靠 requestId 清掉自己的待答卡片（不看 action），这是它唯一的收口信号。
    this.emit({
      type: "elicitation_response",
      taskId: this.options.target.sessionId,
      traceId,
      ...(this.activeInputId ? { inputId: this.activeInputId } : {}),
      requestId: interactionId,
      action: "accept",
    });
  }

  private projectConfig(config: SessionConfigState): void {
    const previous = this.lastConfig;
    this.lastConfig = config;
    if (
      previous &&
      previous.provider === config.provider &&
      previous.model === config.model &&
      previous.thought === config.thought &&
      previous.mode === config.mode &&
      previous.thoughtLevels.join("\u0000") === config.thoughtLevels.join("\u0000")
    ) {
      return;
    }
    const traceId = this.activeInputId ?? generateTraceId(this.options.target.sessionId);
    const base = {
      taskId: this.options.target.sessionId,
      traceId,
      ...(this.activeInputId ? { inputId: this.activeInputId } : {}),
    };
    // 模式：bot 的 /mode 与 UI 工具栏读 mode_update。
    if (!previous || previous.mode !== config.mode) {
      this.emit({
        ...base,
        type: "mode_update",
        currentModeId: normalizeAvailableZCodeMode(config.mode as never),
        availableModes: getZCodeAgentAvailableModes(),
      });
    }
    // 模型/思考档：glm_agent_model_state_update 是旧栈唯一的模型态事件。
    if (
      !previous ||
      previous.provider !== config.provider ||
      previous.model !== config.model ||
      previous.thought !== config.thought ||
      previous.thoughtLevels.join("\u0000") !== config.thoughtLevels.join("\u0000")
    ) {
      this.emit({
        ...base,
        type: "glm_agent_model_state_update",
        version: 1,
        sessionId: this.options.target.sessionId,
        reason: !previous
          ? "session_initialized"
          : previous.provider !== config.provider || previous.model !== config.model
            ? "model_changed"
            : "thought_level_changed",
        model: {
          currentValue: formatModelPickerValue({
            providerId: config.provider,
            modelId: config.model,
            ...(config.thought ? { options: { reasoningLevel: config.thought } } : {}),
          } as ModelSelection),
        },
        thoughtLevel: {
          enabled: config.thoughtLevels.length > 0,
          ...(config.thought ? { currentValue: config.thought } : {}),
          options: config.thoughtLevels.map((level) => ({ value: level, name: level })),
        },
        contextWindow: { tokens: 0 },
      });
      // 顺带把完整 configOptions 发一次：bot 的 /model 列表读它。
      this.emit({ ...base, type: "config_option_update", configOptions: configOptionsFromState(config) });
    }
  }

  private projectUsage(usage: SessionUsageState): void {
    const previous = this.lastUsage;
    this.lastUsage = usage;
    const window = usage.contextWindow;
    if (!window) return;
    if (
      previous?.contextWindow &&
      previous.contextWindow.usedTokens === window.usedTokens &&
      previous.contextWindow.maxTokens === window.maxTokens &&
      previous.cumulative.inputTokens === usage.cumulative.inputTokens &&
      previous.cumulative.outputTokens === usage.cumulative.outputTokens
    ) {
      return;
    }
    const traceId = this.activeInputId ?? generateTraceId(this.options.target.sessionId);
    this.emit({
      type: "usage_update",
      taskId: this.options.target.sessionId,
      traceId,
      ...(this.activeInputId ? { inputId: this.activeInputId } : {}),
      size: window.maxTokens,
      used: window.usedTokens,
      cost: null,
      ...(window.cache ? { cache: window.cache } : {}),
      ...(window.breakdown ? { breakdown: window.breakdown } : {}),
    });
  }

  private projectMeta(meta: SessionMetaState): void {
    if (meta.title === this.lastTitle) return;
    this.lastTitle = meta.title;
    if (!meta.title) return;
    const traceId = this.activeInputId ?? generateTraceId(this.options.target.sessionId);
    this.emit({
      type: "session_info_update",
      taskId: this.options.target.sessionId,
      traceId,
      ...(this.activeInputId ? { inputId: this.activeInputId } : {}),
      title: meta.title,
    });
  }

  private projectPlan(plan: ConversationSnapshot["plan"]): void {
    const steps = (plan?.items ?? []).map((item) => ({
      id: item.id,
      title: item.content,
      status: mapPlanStatus(item.status),
    }));
    this.emitPlanSteps(steps);
  }

  private emitPlanSteps(steps: PlanStep[]): void {
    const fingerprint = steps.map((step) => `${step.id}\u0000${step.status}`).join("\u0001");
    if (!steps.length || fingerprint === this.lastPlanFingerprint) return;
    this.lastPlanFingerprint = fingerprint;
    const traceId = this.activeInputId ?? generateTraceId(this.options.target.sessionId);
    this.emit({
      type: "plan",
      taskId: this.options.target.sessionId,
      traceId,
      ...(this.activeInputId ? { inputId: this.activeInputId } : {}),
      steps,
    });
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
    // 内核的顺序是「先 QueueChanged（队列空了）再 TurnStarted」，所以回合开始是裁决
    // 「消失的队列项到底开跑了还是被丢了」的唯一时点。必须在 task_run_started 之前发，
    // 否则 bot 会先按新回合重置状态，再收到旧输入的丢弃事件。
    this.settleQueueRemovals(inputId);
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
      this.projectToolPlan(row.toolCallId, row.toolName, row.input ?? row.inputText, "input");
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
    if (status === "completed" || status === "failed") {
      this.projectToolPlan(row.toolCallId, row.toolName, row.output?.text, "output");
    }
  }

  /**
   * TodoWrite 的步骤既可以从工具输入取（刚排好计划），也可以从输出取（模型回写状态）。
   * 输入侧先点亮面板，输出侧再按最终状态覆盖；同一份内容不重复发。
   */
  private projectToolPlan(
    toolCallId: string,
    toolName: string,
    value: unknown,
    source: "input" | "output",
  ): void {
    const steps =
      source === "input"
        ? extractPlanStepsFromToolInput({ title: toolName, kind: toolName, input: value })
        : extractPlanStepsFromToolOutput({ title: toolName, kind: toolName, output: value });
    if (!steps) return;
    const fingerprint = steps.map((step) => `${step.id}\u0000${step.status}`).join("\u0001");
    if (this.toolPlanFingerprint.get(toolCallId) === fingerprint) return;
    this.toolPlanFingerprint.set(toolCallId, fingerprint);
    this.emitPlanSteps(steps);
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
    // 全局源 = onDynamicStreamEvent 的入口（bot 的 fallback 分支、Host 间镜像）；
    // onDynamicTaskEvent 那条走上面的 listener。
    this.options.publishGlobal?.(event);
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

function mapPlanStatus(status: string): PlanStep["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "inProgress":
    case "in_progress":
      return "in_progress";
    default:
      return "pending";
  }
}

/** v4 的 permission 选项 → legacy 事件形状（bot 的按钮文案与排序都按它分类）。 */
function permissionOptionsFromPayload(
  options: readonly { optionId: string; label: string; kind: string }[],
  fullAccessOption?: { optionId: string; label: string; kind: string },
): ZCodePermissionOption[] {
  const mapped = options.map((option) => ({
    optionId: option.optionId,
    name: option.label,
    kind: option.kind,
  })) as ZCodePermissionOption[];
  // 「完全访问」是 v4 的附加能力；legacy 事件用 custom 选项承载，bot 会当成普通按钮。
  return fullAccessOption
    ? [
        ...mapped,
        {
          optionId: fullAccessOption.optionId,
          name: fullAccessOption.label,
          kind: "custom",
        } as ZCodePermissionOption,
      ]
    : mapped;
}

/** v4 config → legacy configOptions（bot 的 /model、/mode、/think 菜单读它）。 */
function configOptionsFromState(config: SessionConfigState): ZCodeConfigOption[] {
  const modelValue = formatModelPickerValue({
    providerId: config.provider,
    modelId: config.model,
    ...(config.thought ? { options: { reasoningLevel: config.thought } } : {}),
  } as ModelSelection);
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: modelValue,
      options: [{ value: modelValue, name: modelValue }],
    },
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: normalizeAvailableZCodeMode(config.mode as never),
      options: getZCodeAgentAvailableModes().map((mode) => ({
        value: mode.id,
        name: mode.name,
        ...(mode.description ? { description: mode.description } : {}),
      })),
    },
    {
      id: "thought_level",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: config.thought,
      options: config.thoughtLevels.map((level) => ({ value: level, name: level })),
    },
  ];
}
