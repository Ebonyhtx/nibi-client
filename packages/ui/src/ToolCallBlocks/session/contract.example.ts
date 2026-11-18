import { SessionToolCallBlock, isSessionToolName } from "./contract.js";

/** 注册表只对八个会话工具名选择会话卡，其余工具继续原分流。 */
export function sessionRendererExample(toolName: string) {
  return isSessionToolName(toolName) ? SessionToolCallBlock : undefined;
}