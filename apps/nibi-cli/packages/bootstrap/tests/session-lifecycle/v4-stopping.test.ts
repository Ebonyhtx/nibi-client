import { describe, expect, it } from "vitest";
import { conversationTopic } from "@nibi/shared/nibi-protocol-v4";
import {
  ConversationV4Gateway,
  type V4GatewayHost,
} from "../../src/nibi-protocol-v4/v4-gateway.js";

function makeStoppingGateway(stopping: boolean): ConversationV4Gateway {
  return new ConversationV4Gateway({
    emitWireFrame: () => undefined,
    isSessionStopping: () => stopping,
    sessionExists: () => true,
  } as V4GatewayHost);
}

describe("v4 gateway session lifecycle admission", () => {
  it("rejects conversation subscribe while the lifecycle owner is stopping", async () => {
    const gateway = makeStoppingGateway(true);
    try {
      await expect(
        gateway.subscribeReserved({
          topic: conversationTopic("sess-stopping"),
          connectionId: "conn",
          clientMode: "desktop-continuous",
        }),
      ).rejects.toThrow("fault.sessionLifecycle.stopping");
    } finally {
      gateway.dispose();
    }
  });

  it("keeps subscribe available when no stop is in progress", async () => {
    const gateway = makeStoppingGateway(false);
    try {
      // 没有 stopping 闸门时订阅进入正常 dispatch（空会话返回可用的初始快照）。
      await expect(
        gateway.subscribeReserved({
          topic: conversationTopic("sess-ready"),
          connectionId: "conn",
          clientMode: "desktop-continuous",
        }),
      ).resolves.toBeDefined();
    } finally {
      gateway.dispose();
    }
  });
});
