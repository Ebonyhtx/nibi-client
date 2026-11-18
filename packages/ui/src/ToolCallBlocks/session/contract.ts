/** 会话工具展示入口；只消费既有 tool call，不发起会话操作或额外查询。 */
export {
  SessionToolCallBlock,
  isSessionToolCallRenderable,
  isSessionToolName,
} from "@/ToolCallBlocks/session/session.js";