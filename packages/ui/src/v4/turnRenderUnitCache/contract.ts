/**
 * ui-turn-render-unit-cache 对外契约：按当前窗口缓存 turn 级 render unit；未变化的 turn
 * 返回同一对象引用，已完成 turn 不随时钟失效。
 */
export { ConversationTurnRenderUnitCache } from "./index.js";
