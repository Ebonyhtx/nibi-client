// worktree_creation timeline：Host 可信事实先记 pending，首轮持久化后、TurnStarted 前落盘为
// worklog timeline part，并发 WorktreeCreated；重复命令保持第一次的事实（冷恢复/投影见 bootstrap 测试）。
import { describe, expect, it, vi } from "vitest";
import {
  SessionEventType,
  createSessionId,
  type MessageInfo,
  type MessagePart,
  type SessionInfo,
  type SessionStorePort,
} from "@nibi/contracts";
import { createTestAgentRuntime } from "./test-agent-runtime.js";
import { createTestSessionEventStore } from "./test-event-store.js";
import { createTestModelFactory } from "./test-runtime-model.js";

const FACT = {
  path: "/worktrees/3f2a/project",
  sha: "abc123",
  ref: null,
  output: "Preparing worktree\ngit checkout abc123",
};

/**
 * 最小会话存储：只记录落库顺序，供断言「会话行 → worktree part → TurnStarted」。
 * 其他读写面由 runtime 的既有契约兜底（首轮只会走 createSession / saveSessionEntry / saveMessage / savePart）。
 */
function createOrderedStore(order: string[], messages: MessageInfo[], parts: MessagePart[]) {
  const sessions = new Map<string, SessionInfo>();
  const store = {
    async createSession(input: SessionInfo) {
      order.push("createSession");
      const session = {
        ...input,
        taskType: input.taskType ?? "interactive",
        time: { created: 1, updated: 1 },
      } satisfies SessionInfo;
      sessions.set(input.id, session);
      return session;
    },
    async updateSession(input: Partial<SessionInfo> & { id: string }) {
      return { ...sessions.get(input.id)!, ...input } as SessionInfo;
    },
    async getSession(id: string) {
      return sessions.get(id) ?? null;
    },
    async saveMessage(message: MessageInfo) {
      order.push(`message:${message.role}`);
      messages.push(message);
    },
    async savePart(part: MessagePart) {
      order.push(`part:${part.type}:${"timelineType" in part ? part.timelineType : ""}`);
      parts.push(part);
    },
    async saveSessionEntry() {},
    async messages() {
      return [];
    },
  };
  return store as unknown as SessionStorePort;
}

describe("worktree_creation timeline", () => {
  it("首轮：会话落库之后、TurnStarted 之前写 worklog part 并发 WorktreeCreated，只记第一次事实", async () => {
    const sessionId = createSessionId("runtime-worktree-creation");
    const order: string[] = [];
    const messages: MessageInfo[] = [];
    const parts: MessagePart[] = [];
    const store = createOrderedStore(order, messages, parts);
    const eventStore = createTestSessionEventStore();
    const append = eventStore.append.bind(eventStore);
    const appendSpy = vi.spyOn(eventStore, "append").mockImplementation(async (event) => {
      order.push(`event:${event.type}`);
      return append(event);
    });

    const runtime = createTestAgentRuntime(
      sessionId,
      { agentName: "worktree-test", workingDirectory: "/worktrees/3f2a/project" },
      {
        eventStore,
        modelFactory: createTestModelFactory({
          async generateText() {
            return {
              text: "done",
              finishReason: "stop",
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
            };
          },
        } as never),
        sessionStore: store,
      },
    );

    // 同一命令重试：第二次的 sha 不能覆盖第一次的事实。
    runtime.recordPendingWorktreeCreation(FACT);
    runtime.recordPendingWorktreeCreation({ ...FACT, sha: "retry-sha" });

    await runtime.executeTurn("开始工作");

    const timelineParts = parts.filter(
      (part) =>
        part.type === "timeline" &&
        "timelineType" in part &&
        part.timelineType === "worktree_creation",
    );
    expect(timelineParts).toHaveLength(1);
    expect(timelineParts[0]).toMatchObject({
      type: "timeline",
      timelineType: "worktree_creation",
      display: "worklog",
      status: "completed",
      worktreeCreation: FACT,
    });

    const events = await eventStore.getEvents(sessionId);
    const created = events.filter((event) => event.type === SessionEventType.WorktreeCreated);
    expect(created).toHaveLength(1);
    expect(created[0]?.payload).toEqual(FACT);

    const position = (needle: string) => {
      const index = order.indexOf(needle);
      expect(index, `missing ${needle} in ${order.join(" | ")}`).toBeGreaterThanOrEqual(0);
      return index;
    };
    const sessionCreated = position("createSession");
    const partWritten = position("part:timeline:worktree_creation");
    const worktreeEvent = position(`event:${SessionEventType.WorktreeCreated}`);
    const turnStarted = position(`event:${SessionEventType.TurnStarted}`);
    expect(sessionCreated).toBeLessThan(partWritten);
    expect(partWritten).toBeLessThan(worktreeEvent);
    expect(worktreeEvent).toBeLessThan(turnStarted);

    // 第二轮不会重复写：pending 事实只消费一次。
    await runtime.executeTurn("继续");
    expect(
      parts.filter(
        (part) =>
          part.type === "timeline" &&
          "timelineType" in part &&
          part.timelineType === "worktree_creation",
      ),
    ).toHaveLength(1);
    expect(
      (await eventStore.getEvents(sessionId)).filter(
        (event) => event.type === SessionEventType.WorktreeCreated,
      ),
    ).toHaveLength(1);
    appendSpy.mockRestore();
  });
});
