import {
  NIBI_SESSION_TOOL_NAMES,
  isNibiSessionToolName,
  type NibiSessionToolName,
} from "@nibi/shared";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";

export type SessionToolCall = ToolCallBlockRenderContext["toolCallNode"]["toolCall"];

export type SessionStatusKey =
  | "unknown"
  | "idle"
  | "running"
  | "attention"
  | "accepted"
  | "queued"
  | "completed"
  | "stopped"
  | "failed"
  | "rejected"
  | "pending"
  | "waitEnded"
  | "timedOut"
  | "cancelled"
  | "created"
  | "applied"
  | "inputRejected"
  | "started"
  | "deliveryNone"
  | "opened"
  | "unavailable"
  | "textResult";

export const SESSION_STATE_KEYS: Record<string, SessionStatusKey> = {
  unknown: "unknown",
  idle: "idle",
  running: "running",
  needs_attention: "attention",
  accepted: "accepted",
  queued: "queued",
  completed: "completed",
  interrupted: "stopped",
  failed: "failed",
};

export const WAIT_STATUS_KEYS: Record<string, SessionStatusKey> = {
  completed: "waitEnded",
  timed_out: "timedOut",
  cancelled: "cancelled",
  unknown: "unknown",
};

export const SESSION_TOOL_NAME_BY_LOWER = new Map<string, NibiSessionToolName>(
  NIBI_SESSION_TOOL_NAMES.map((toolName) => [toolName.toLowerCase(), toolName]),
);

export function normalizeSessionToolName(value: string | null | undefined): NibiSessionToolName | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? (SESSION_TOOL_NAME_BY_LOWER.get(normalized) ?? null) : null;
}

export function isSessionToolName(value: string | null | undefined): boolean {
  return isNibiSessionToolName(value);
}

export function parseValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function toRecord(value: unknown): Record<string, unknown> {
  const parsed = parseValue(value);
  return isPlainRecord(parsed) ? parsed : {};
}

export function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function readRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(toRecord) : [];
}

export function readSessionRefId(value: unknown): string | undefined {
  return readText(toRecord(value).sessionId);
}

export function shortId(value: string): string {
  return value.length > 20 ? `${value.slice(0, 12)}…${value.slice(-6)}` : value;
}

/** 折叠行只放一行摘要；不改变展开区里的原文。 */
export function summarizeText(value: string, maxLength = 96): string {
  const singleLine = value.replace(/\s+/g, " ").trim();
  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength - 1)}…` : singleLine;
}

export function readResult(toolCall: SessionToolCall): unknown {
  // 已有 output 是当前投影的唯一结果；只有字段缺失才读取旧快照 rawOutput，
  // 避免旧成功覆盖新失败。
  return parseValue(
    toolCall.output === undefined ? toRecord(toolCall.raw).rawOutput : toolCall.output,
  );
}

/**
 * 会话卡片只认自己的回执形状；形状读不懂时交回通用 fallback 卡。
 * 运行中/被中止的工具没有可判定的回执，仍由会话卡片展示进度与错误。
 */
export function isSessionToolCallRenderable(toolCall: SessionToolCall): boolean {
  const name = normalizeSessionToolName(toolCall.toolName ?? toolCall.kind);
  if (name === null) {
    return false;
  }

  const status = toolCall.status;
  if (
    status === "pending" ||
    status === "running" ||
    status === "in_progress" ||
    status === "failed" ||
    status === "denied" ||
    status === "stopped"
  ) {
    return true;
  }

  const result = readResult(toolCall);
  // 大结果预算会把 JSON 转成保存提示或截断文本；解析失败不是空结果，必须保留原文。
  if (typeof result === "string" || result === undefined || result === null) {
    return true;
  }
  if (!isPlainRecord(result)) {
    return false;
  }

  switch (name) {
    case "ListSessions":
      return Array.isArray(result.sessions);
    case "ReadSession":
      return result.view === "summary" || result.view === "messages";
    case "CreateSession":
      return typeof result.creation === "string";
    case "ForkSession":
      return typeof result.status === "string";
    case "SendToSession":
      return typeof result.admission === "string" || typeof result.delivery === "string";
    case "WaitSessions":
      return Array.isArray(result.operations) && typeof result.status === "string";
    case "InterruptSession":
    case "RenameSession":
      return typeof result.status === "string";
    case "ListProjects":
      return Array.isArray(result.projects);
    case "OpenSession":
      return result.status === "opened" || result.status === "unavailable";
    case "SetSessionArchived":
    case "SetSessionPinned":
      return typeof result.status === "string";
  }
}

export function readMutationStatusKey(value: unknown): SessionStatusKey {
  const status = readText(value);
  return status === "created" || status === "applied" || status === "rejected" ? status : "unknown";
}

/** OpenSession 的 status 是 opened/unavailable；其它值不猜。 */
export function readOpenStatusKey(value: unknown): SessionStatusKey {
  const status = readText(value);
  return status === "opened" || status === "unavailable" ? status : "unknown";
}

/** App 项目引用的展示 id：projectId 优先，source 只在有值时参与短 id。 */
export function readProjectRef(value: unknown): { id?: string; source?: string } {
  const record = toRecord(value);
  return {
    id: readText(record.projectId),
    source: readText(record.sourceServerId),
  };
}

export function readAdmissionStatusKey(value: unknown): SessionStatusKey {
  const admission = readText(value);
  if (admission === "accepted" || admission === "rejected") {
    return admission;
  }
  return "unknown";
}

export function readDeliveryStatusKey(value: unknown): SessionStatusKey {
  const delivery = readText(value);
  if (delivery === "start_now") {
    return "started";
  }
  if (delivery === "queued") {
    return "queued";
  }
  if (delivery === "none") {
    return "deliveryNone";
  }
  return "unknown";
}

export function readCreationStatusKey(value: unknown): SessionStatusKey {
  const creation = readText(value);
  return creation === "created" || creation === "rejected" ? creation : "unknown";
}

export function readSendStatusKey(output: Record<string, unknown>): SessionStatusKey {
  const admission = readText(output.admission);
  const delivery = readText(output.delivery);
  if (admission === "rejected") {
    return "rejected";
  }
  if (admission === "accepted") {
    return delivery === "queued" ? "queued" : "accepted";
  }
  return "unknown";
}

export function readCreateStatusKey(output: Record<string, unknown>): SessionStatusKey {
  const creation = readText(output.creation);
  const firstInput = readText(output.firstInput);
  const delivery = readText(output.delivery);
  if (creation === "rejected") {
    return "rejected";
  }
  if (creation !== "created") {
    return "unknown";
  }
  if (firstInput === "rejected") {
    return "inputRejected";
  }
  if (firstInput !== "accepted") {
    return "unknown";
  }
  if (delivery === "queued") {
    return "queued";
  }
  if (delivery === "start_now") {
    return "started";
  }
  if (delivery === "none") {
    return "deliveryNone";
  }
  return "accepted";
}

export function formatUpdatedAt(locale: string, value: unknown): string | undefined {
  const raw = readText(value);
  if (raw === undefined) {
    return undefined;
  }
  const timestamp = Date.parse(raw);
  if (Number.isNaN(timestamp)) {
    // 无法解析的时间戳原样展示，不猜一个时间。
    return raw;
  }
  return new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export function isOutputTruncated(toolCall: SessionToolCall): boolean {
  return toRecord(toolCall.raw).outputTruncated === true;
}

export function isTruncationNotice(value: string | undefined): boolean {
  return value !== undefined && /<persisted-output>|tool output truncated/i.test(value);
}
