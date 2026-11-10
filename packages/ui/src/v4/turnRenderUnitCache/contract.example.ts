import { ConversationTurnRenderUnitCache } from "./contract.js";

export function exampleUiTurnRenderUnitCache(): number {
  const cache = new ConversationTurnRenderUnitCache();
  cache.build([], { nowMs: 1_000 });
  return cache.size;
}
