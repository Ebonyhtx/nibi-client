import { describe, expect, it } from "vitest";
import {
  deriveNibiTaskStatusFromSessionSnapshot,
  type NibiSessionStateSnapshot,
} from "../src/index.js";

type SnapshotOptions = {
  sessionStatus?: NibiSessionStateSnapshot["session"]["status"];
  assistantCompletedAt?: number;
  assistantFinish?: string;
  activeTurnKind?: NibiSessionStateSnapshot["runtime"]["activeTurnKind"];
  activeTurnId?: string;
  currentTurnId?: string;
  lastError?: NibiSessionStateSnapshot["projection"]["lastError"];
};

function snapshot(options: SnapshotOptions = {}): NibiSessionStateSnapshot {
  const messages: NibiSessionStateSnapshot["messages"] = [
    {
      info: {
        messageId: "msg_user",
        role: "user",
        time: { created: 1, completed: 1 },
      },
      parts: [{ partId: "part_user", type: "text", text: "continue" }],
    },
  ] as NibiSessionStateSnapshot["messages"];
  if (typeof options.assistantCompletedAt === "number" || options.assistantFinish) {
    messages.push({
      info: {
        messageId: "msg_assistant",
        sessionId: "sess_status",
        parentMessageId: "msg_user",
        role: "assistant",
        time: {
          created: 2,
          ...(typeof options.assistantCompletedAt === "number"
            ? { completed: options.assistantCompletedAt }
            : {}),
        },
        finish: options.assistantFinish,
      },
      parts: [{ partId: "part_assistant", type: "text", text: "done" }],
    } as NibiSessionStateSnapshot["messages"][number]);
  }

  return {
    session: {
      status: options.sessionStatus ?? "idle",
    },
    projection: {
      target: null,
      lastError: options.lastError ?? null,
      currentTurnId: options.currentTurnId,
      pendingPermissions: [],
      activeToolCalls: [],
    },
    runtime: {
      activeTurnId: options.activeTurnId,
      activeTurnKind: options.activeTurnKind,
    },
    messages,
  } as unknown as NibiSessionStateSnapshot;
}

describe("deriveNibiTaskStatusFromSessionSnapshot", () => {
  it("treats idle snapshots with a completed visible assistant turn as completed", () => {
    expect(
      deriveNibiTaskStatusFromSessionSnapshot(
        snapshot({
          sessionStatus: "idle",
          assistantCompletedAt: 3,
        }),
      ),
    ).toBe("completed");
  });

  it("does not treat tool-call continuation assistant turns as completed", () => {
    expect(
      deriveNibiTaskStatusFromSessionSnapshot(
        snapshot({
          sessionStatus: "idle",
          assistantCompletedAt: 3,
          assistantFinish: "tool_calls",
        }),
      ),
    ).toBeUndefined();
  });

  it("keeps active runtime snapshots running even when session status is idle", () => {
    expect(
      deriveNibiTaskStatusFromSessionSnapshot(
        snapshot({
          sessionStatus: "idle",
          activeTurnId: "turn_active",
        }),
      ),
    ).toBe("running");
  });

  it("does not treat the last projected turn id as active runtime", () => {
    expect(
      deriveNibiTaskStatusFromSessionSnapshot(
        snapshot({
          sessionStatus: "idle",
          currentTurnId: "turn_completed",
        }),
      ),
    ).toBeUndefined();
  });

  it("keeps completed idle snapshots completed when only currentTurnId remains", () => {
    expect(
      deriveNibiTaskStatusFromSessionSnapshot(
        snapshot({
          sessionStatus: "idle",
          currentTurnId: "turn_completed",
          assistantCompletedAt: 3,
        }),
      ),
    ).toBe("completed");
  });

  it("treats a completed assistant as terminal when only stale projection currentTurnId remains", () => {
    expect(
      deriveNibiTaskStatusFromSessionSnapshot(
        snapshot({
          sessionStatus: "running",
          assistantCompletedAt: 3,
          currentTurnId: "turn_stale",
        }),
      ),
    ).toBe("completed");
  });

  it("keeps real active compact snapshots running even after a previous assistant completed", () => {
    expect(
      deriveNibiTaskStatusFromSessionSnapshot(
        snapshot({
          sessionStatus: "running",
          assistantCompletedAt: 3,
          activeTurnId: "turn_compact",
          activeTurnKind: "compact",
        }),
      ),
    ).toBe("running");
  });

  it("prefers projection lastError over a previous completed assistant message", () => {
    expect(
      deriveNibiTaskStatusFromSessionSnapshot(
        snapshot({
          sessionStatus: "idle",
          assistantCompletedAt: 3,
          lastError: { message: "quota exceeded" },
        }),
      ),
    ).toBe("error");
  });
});
