import { describe, expect, it } from "vitest";

import { ConversationTurnRenderUnitCache } from "./contract.js";
import { uiTurnRenderUnitCacheModule } from "./module.js";

describe("ui-turn-render-unit-cache contract", () => {
  it("declares its module manifest", () => {
    expect(uiTurnRenderUnitCacheModule.id).toBe("ui-turn-render-unit-cache");
  });
  it("drops turns outside the current window", () => {
    const cache = new ConversationTurnRenderUnitCache();
    expect(cache.build([], { nowMs: 1_000 })).toEqual([]);
    expect(cache.size).toBe(0);
  });
});
