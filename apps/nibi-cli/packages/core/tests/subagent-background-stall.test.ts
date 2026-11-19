// ============================================================
// 后台 subagent 无进展提醒（docs/design/v2/tool/07-subagent.md「后台 Agent 无进展提醒」）
// ============================================================
// 钟本身：首次 15 分钟，之后 30/60/120/240 分钟封顶；真实进展清零；审批等待与前台 Agent 不提醒。
// 出队围栏：排队期间 Agent 结束 / 有新进展 / 换执行 / 进入审批后，旧提醒必须丢弃。
// 全部用假时钟与假定时器，一毫秒都不真等。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionEventType, createRootTraceContext, createSessionEvent, createSessionId } from "@nibi/contracts";
import type { SessionEvent, SessionId } from "@nibi/contracts";
import {
  BackgroundSubagentStallClock,
  formatBackgroundSubagentStallNotification,
  isBackgroundSubagentStallReminderCurrent,
  noteSubagentActivity,
  type BackgroundSubagentStallReminder,
} from "../src/subagent/background-stall.js";
import {
  InMemoryRuntimeTaskRegistry,
  type RuntimeTaskSnapshot,
} from "../src/runtime-task/registry.js";
import { shouldSuppressTaskNotificationRuntimeCommand } from "../src/runtime/methods/background-notifications.js";
import { createSubagentStallReminder } from "../src/runtime/methods/subagent-stall-reminder.js";
import {
  createRuntimeCommandId,
  type TaskNotificationRuntimeCommand,
} from "../src/runtime/command-queue.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

const MIN = 60_000;
// 使用规格时间推进钟；不从实现读取期望值，避免延迟改错后测试跟着通过。
const FIRST = 15 * MIN;
const MAX_INTERVAL = 4 * 60 * MIN;

const sessionId: SessionId = createSessionId("subagent-stall-test");

function runningTask(overrides: Partial<RuntimeTaskSnapshot> = {}): RuntimeTaskSnapshot {
  return {
    taskId: "agent-1",
    executionId: "exec-1",
    agentId: "agent-1",
    agentType: "general-purpose",
    description: "audit the repo",
    status: "running",
    startedAt: new Date(0),
    isBackgrounded: true,
    type: "local_agent",
    ...overrides,
  };
}

function event(type: SessionEvent["type"], payload: unknown): SessionEvent {
  return createSessionEvent(type, sessionId, payload);
}

interface Harness {
  registry: InMemoryRuntimeTaskRegistry;
  clock: BackgroundSubagentStallClock;
  sent: BackgroundSubagentStallReminder[];
  advance(ms: number): Promise<void>;
}

function harness(options?: {
  firstAfterMs?: number;
  maxIntervalMs?: number;
  backgroundOnly?: boolean;
}): Harness {
  const registry = new InMemoryRuntimeTaskRegistry();
  const sent: BackgroundSubagentStallReminder[] = [];
  const clock = new BackgroundSubagentStallClock(
    {
      now: () => Date.now(),
      liveAgents: () =>
        Object.values(registry.all()).filter(
          (task) =>
            task.type === "local_agent" &&
            task.status === "running" &&
            (options?.backgroundOnly === false || task.isBackgrounded === true),
        ),
      remind: (reminder) => sent.push(reminder),
      setTimer: (callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        handle.unref?.();
        return () => clearTimeout(handle);
      },
    },
    options,
  );
  registry.subscribe(() => clock.reconcile());
  return {
    registry,
    clock,
    sent,
    advance: (ms) => vi.advanceTimersByTimeAsync(ms),
  };
}

describe("BackgroundSubagentStallClock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("首次提醒在无进展 15 分钟后，下一次间隔 30 分钟", async () => {
    const { registry, sent, advance } = harness();
    registry.register(runningTask());

    await advance(FIRST - 1);
    expect(sent).toHaveLength(0);

    await advance(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      agentId: "agent-1",
      executionId: "exec-1",
      runningForMs: FIRST,
      noProgressForMs: FIRST,
      lastProgressAt: 0,
      nextReportInMs: 2 * FIRST,
      ordinal: 1,
    });
  });

  it("间隔逐次加倍并在 4 小时封顶", async () => {
    const { registry, sent, advance } = harness();
    registry.register(runningTask());

    await advance(FIRST);
    for (const interval of [2 * FIRST, 4 * FIRST, 8 * FIRST, MAX_INTERVAL]) {
      await advance(interval);
    }

    expect(sent.map((reminder) => reminder.nextReportInMs)).toEqual([
      2 * FIRST,
      4 * FIRST,
      8 * FIRST,
      MAX_INTERVAL,
      MAX_INTERVAL,
    ]);
    expect(sent.map((reminder) => reminder.ordinal)).toEqual([1, 2, 3, 4, 5]);
  });

  it("真实进展后计数清零，重新按首次间隔计时", async () => {
    const { registry, sent, advance } = harness();
    registry.register(runningTask());

    await advance(FIRST);
    expect(sent).toHaveLength(1);

    // 第 16 分钟模型发起新请求：进展前进，下一次从这一刻重新算 15 分钟。
    await advance(MIN);
    noteSubagentActivity(
      registry,
      "agent-1",
      event(SessionEventType.ModelRequest, { model: "test" }),
      Date.now(),
      "exec-1",
    );

    await advance(FIRST - 1);
    expect(sent).toHaveLength(1);

    await advance(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      lastProgressAt: 16 * MIN,
      noProgressForMs: FIRST,
      runningForMs: 31 * MIN,
      ordinal: 1,
    });
  });

  it("等待审批时不提醒，审批结束后重新计时", async () => {
    const { registry, sent, advance } = harness();
    registry.register(runningTask());

    await advance(MIN);
    noteSubagentActivity(
      registry,
      "agent-1",
      event(SessionEventType.PermissionRequested, { toolCallId: "tool-1", toolName: "Bash" }),
      Date.now(),
      "exec-1",
    );
    expect(registry.get("agent-1")?.activity?.waitingForPermission).toBe(true);

    await advance(30 * MIN);
    expect(sent).toHaveLength(0);

    noteSubagentActivity(
      registry,
      "agent-1",
      event(SessionEventType.PermissionResolved, { toolCallId: "tool-1", decision: "allow" }),
      Date.now(),
      "exec-1",
    );
    await advance(FIRST - 1);
    expect(sent).toHaveLength(0);
    await advance(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ noProgressForMs: FIRST, ordinal: 1 });
  });

  it("前台 Agent 不提醒", async () => {
    const { registry, sent, advance } = harness();
    registry.register(runningTask({ isBackgrounded: false }));

    await advance(60 * MIN);
    expect(sent).toHaveLength(0);
  });

  it("同一到期时间只提醒一次", async () => {
    const { registry, clock, sent, advance } = harness();
    registry.register(runningTask());

    await advance(FIRST);
    expect(sent).toHaveLength(1);

    // registry 的每次变化都会 reconcile：同一时刻反复对齐不能重复提醒。
    clock.reconcile();
    clock.reconcile();
    await advance(0);
    expect(sent).toHaveLength(1);

    await advance(MIN);
    expect(sent).toHaveLength(1);
  });

  it("runtime 接线：入队提醒但不改 notified，也不带 subagentResult", async () => {
    interface CapturedNotification {
      originMeta?: { subagentStall?: unknown; subagentResult?: unknown };
      taskId?: string;
      text: string;
    }
    const registry = new InMemoryRuntimeTaskRegistry();
    const enqueued: CapturedNotification[] = [];
    const runtime = {
      config: { subagents: {} },
      runtimeTaskRegistry: registry,
      sessionId,
      branchGeneration: 0,
      shuttingDown: false,
      rootTraceContext: createRootTraceContext({ sessionId }),
      enqueueBackgroundTaskNotification: (notification: CapturedNotification) => {
        enqueued.push(notification);
      },
    } as unknown as AgentRuntimeInternal;
    const clock = createSubagentStallReminder(runtime);

    registry.register(runningTask());
    await vi.advanceTimersByTimeAsync(FIRST);

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.taskId).toBe("agent-1");
    expect(enqueued[0]?.originMeta?.subagentStall).toEqual({
      noProgressForMs: FIRST,
      lastProgressAt: 0,
      executionId: "exec-1",
    });
    // 提醒不是结果，也不是终态：卡片状态与去重标记都不能被它改写。
    expect(enqueued[0]?.originMeta?.subagentResult).toBeUndefined();
    expect(registry.get("agent-1")?.notified).toBeUndefined();
    expect(enqueued[0]?.text).toContain("<background-agent-stall>");
    clock.dispose();
  });

  it("ToolCallProgress 心跳不算进展", async () => {
    const { registry, sent, advance } = harness();
    registry.register(runningTask());

    await advance(MIN);
    noteSubagentActivity(
      registry,
      "agent-1",
      event(SessionEventType.ToolCallStarted, { toolCallId: "tool-1", toolName: "Bash" }),
      Date.now(),
      "exec-1",
    );
    expect(registry.get("agent-1")?.activity?.lastProgressAt).toBe(MIN);

    // 每秒的心跳不推进 lastProgressAt，也不改变在途工具的开始时间。
    await advance(MIN);
    noteSubagentActivity(
      registry,
      "agent-1",
      event(SessionEventType.ToolCallProgress, {
        toolCallId: "tool-1",
        toolName: "Bash",
        progress: "still running",
      }),
      Date.now(),
      "exec-1",
    );
    expect(registry.get("agent-1")?.activity?.lastProgressAt).toBe(MIN);
    expect(registry.get("agent-1")?.activity?.runningTools[0]?.startedAt).toBe(MIN);

    await advance(14 * MIN);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      noProgressForMs: FIRST,
      runningTools: [
        { toolCallId: "tool-1", toolName: "Bash", startedAt: MIN, runningForMs: FIRST },
      ],
    });
  });
});

describe("isBackgroundSubagentStallReminderCurrent", () => {
  it("仅当任务仍在跑且进展、执行身份一致时成立", () => {
    const task = runningTask({
      activity: { lastProgressAt: 1_000, runningTools: [], waitingForPermission: false },
    });

    expect(isBackgroundSubagentStallReminderCurrent(task, { lastProgressAt: 1_000 })).toBe(true);
    expect(
      isBackgroundSubagentStallReminderCurrent(task, {
        lastProgressAt: 1_000,
        executionId: "exec-1",
      }),
    ).toBe(true);

    // 有新进展：提醒内容已不成立。
    expect(isBackgroundSubagentStallReminderCurrent(task, { lastProgressAt: 2_000 })).toBe(false);
    // 换执行（SendMessage 恢复）。
    expect(
      isBackgroundSubagentStallReminderCurrent(task, {
        lastProgressAt: 1_000,
        executionId: "exec-2",
      }),
    ).toBe(false);
    // 进入审批。
    expect(
      isBackgroundSubagentStallReminderCurrent(
        { ...task, activity: { ...task.activity!, waitingForPermission: true } },
        { lastProgressAt: 1_000 },
      ),
    ).toBe(false);
    // 终态 / 任务消失。
    expect(
      isBackgroundSubagentStallReminderCurrent({ ...task, status: "completed" }, {}),
    ).toBe(false);
    expect(isBackgroundSubagentStallReminderCurrent(undefined, {})).toBe(false);
  });
});

describe("shouldSuppressTaskNotificationRuntimeCommand", () => {
  function stallCommand(stall: {
    noProgressForMs: number;
    lastProgressAt?: number;
    executionId?: string;
  }): TaskNotificationRuntimeCommand {
    return {
      branchGeneration: 0,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      mode: "task-notification",
      priority: "next",
      source: "background_task",
      originMeta: {
        backgroundSource: "subagent",
        title: "audit the repo — no progress for 15 min",
        workId: "agent-1",
        subagentStall: stall,
      },
      taskId: "agent-1",
      text: "reminder",
      traceContext: createRootTraceContext({ sessionId }),
    };
  }

  function runtimeContext(registry: InMemoryRuntimeTaskRegistry): AgentRuntimeInternal {
    return {
      backgroundTaskNotificationsSealed: false,
      config: { taskType: "main" },
      runtimeTaskRegistry: registry,
    } as unknown as AgentRuntimeInternal;
  }

  it("出队时进展已前进：丢弃旧提醒", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    registry.register(
      runningTask({
        activity: { lastProgressAt: 2_000, runningTools: [], waitingForPermission: false },
      }),
    );
    const context = runtimeContext(registry);

    expect(
      shouldSuppressTaskNotificationRuntimeCommand.call(
        context,
        stallCommand({ noProgressForMs: FIRST, lastProgressAt: 1_000 }),
      ),
    ).toBe(true);
  });

  it("出队时任务已结束或已换执行：丢弃旧提醒", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    registry.register(
      runningTask({
        status: "completed",
        activity: { lastProgressAt: 1_000, runningTools: [], waitingForPermission: false },
      }),
    );
    const context = runtimeContext(registry);
    expect(
      shouldSuppressTaskNotificationRuntimeCommand.call(
        context,
        stallCommand({ noProgressForMs: FIRST, lastProgressAt: 1_000 }),
      ),
    ).toBe(true);

    registry.register(
      runningTask({
        executionId: "exec-2",
        activity: { lastProgressAt: 1_000, runningTools: [], waitingForPermission: false },
      }),
    );
    expect(
      shouldSuppressTaskNotificationRuntimeCommand.call(
        context,
        stallCommand({ noProgressForMs: FIRST, lastProgressAt: 1_000, executionId: "exec-1" }),
      ),
    ).toBe(true);
  });

  it("提醒仍然成立：放行", () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    registry.register(
      runningTask({
        activity: { lastProgressAt: 1_000, runningTools: [], waitingForPermission: false },
      }),
    );
    const context = runtimeContext(registry);

    expect(
      shouldSuppressTaskNotificationRuntimeCommand.call(
        context,
        stallCommand({ noProgressForMs: FIRST, lastProgressAt: 1_000, executionId: "exec-1" }),
      ),
    ).toBe(false);
  });
});

describe("formatBackgroundSubagentStallNotification", () => {
  it("用 background-agent-stall 块而不是 task-notification，并列出在途工具", () => {
    const text = formatBackgroundSubagentStallNotification({
      agentId: "agent-1",
      executionId: "exec-1",
      description: "audit <repo>",
      runningForMs: 20 * MIN,
      noProgressForMs: 15 * MIN,
      lastProgressAt: 5 * MIN,
      runningTools: [
        { toolCallId: "tool-1", toolName: "Bash", startedAt: 0, runningForMs: 15 * MIN, summary: "pnpm test" },
        { toolCallId: "tool-2", toolName: "Read", startedAt: 0, runningForMs: 5 * MIN },
      ],
      nextReportInMs: 30 * MIN,
      ordinal: 1,
    });

    expect(text).toContain("[SYSTEM NOTIFICATION - NOT USER INPUT]");
    expect(text).toContain("<background-agent-stall>");
    expect(text).not.toContain("<task-notification>");
    expect(text).toContain("<task-id>agent-1</task-id>");
    expect(text).toContain("<description>audit &lt;repo&gt;</description>");
    expect(text).toContain('<running-tool name="Bash" running-for-ms="900000">pnpm test</running-tool>');
    expect(text).toContain("<next-report-in-ms>1800000</next-report-in-ms>");
  });
});
