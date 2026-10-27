import { describe, expect, it } from "vitest";

describe("services package entry boundaries", () => {
  it("keeps conversation-share runtime implementations out of the browser-safe root entry", async () => {
    const browserSafeEntry = await import("@nibi/services");

    expect(browserSafeEntry.IConversationShareService).toBeDefined();
    expect(browserSafeEntry.ConversationShareServiceError).toBeDefined();
    expect(browserSafeEntry).not.toHaveProperty("ConversationShareService");
    expect(browserSafeEntry).not.toHaveProperty("ConversationShareHttpClient");
  });

  it("exposes conversation-share runtime implementations from the node entry", async () => {
    const nodeEntry = await import("@nibi/services/node");

    expect(nodeEntry.ConversationShareService).toBeDefined();
    expect(nodeEntry.ConversationShareHttpClient).toBeDefined();
  });

  it("keeps the conversation-share test double out of both published entries", async () => {
    // Mock 只服务单测；一旦被 re-export 就会随 @nibi/services 进入桌面端产物。
    const [browserSafeEntry, nodeEntry] = await Promise.all([
      import("@nibi/services"),
      import("@nibi/services/node"),
    ]);

    expect(browserSafeEntry).not.toHaveProperty("ConversationShareMockApiClient");
    expect(nodeEntry).not.toHaveProperty("ConversationShareMockApiClient");
  });
});
