// 原始 -32602 文案来自旧 Agent schema，跨 RPC 后 UI 不能靠易变字符串识别能力缺失。
// ChannelClient 会保留 error.code，因此用稳定 code 驱动设置页停止 status-only 轮询。
export const NIBI_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE =
  "NIBI_AGENT_MCP_STATUS_MODE_UNSUPPORTED";

export class ZCodeAgentMcpStatusModeUnsupportedError extends Error {
  readonly code = NIBI_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE;

  constructor() {
    super("The connected NIBI Agent does not support MCP status-only refresh");
    this.name = "ZCodeAgentMcpStatusModeUnsupportedError";
  }
}

export function isZCodeAgentMcpStatusModeUnsupportedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (error as { code?: unknown }).code === NIBI_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE;
}

// 旧内核没有 v4/storage/sessionData/*，-32601 跨 RPC 后不能再靠文案识别；
// 用稳定 code 让 Host 的 project 服务把「不支持清理数据」映射为可隐藏入口的事实。
export const NIBI_AGENT_SESSION_DATA_UNSUPPORTED_ERROR_CODE = "NIBI_AGENT_SESSION_DATA_UNSUPPORTED";

export class ZCodeAgentSessionDataUnsupportedError extends Error {
  readonly code = NIBI_AGENT_SESSION_DATA_UNSUPPORTED_ERROR_CODE;

  constructor() {
    super("The connected NIBI Agent does not support project session data cleanup");
    this.name = "ZCodeAgentSessionDataUnsupportedError";
  }
}

export function isZCodeAgentSessionDataUnsupportedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (error as { code?: unknown }).code === NIBI_AGENT_SESSION_DATA_UNSUPPORTED_ERROR_CODE;
}
