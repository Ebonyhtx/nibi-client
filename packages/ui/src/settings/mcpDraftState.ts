/**
 * MCP 表单草稿态判定与校验。
 *
 * 草稿只存在于表单组件内存里：这里不读写 mcpStore、不触碰配置文件，
 * 因此输入过程中的任何校验/脏检查都不会触发 MCP 重连或落盘。
 */
import type { FormState } from "./mcpSettingsShared.js";
import { McpJsonDraftError } from "./mcpSettingsShared.js";

export type McpDraftField =
  | "json"
  | "name"
  | "command"
  | "url"
  | "timeoutMs"
  | "env"
  | "headers"
  | "oauth";

export type McpDraftErrors = Partial<Record<McpDraftField, string>>;

export interface McpDraftValidation {
  valid: boolean;
  errors: McpDraftErrors;
}

// 逐字段比较而不是 JSON.stringify：FormState 里 oauth 是可选字段，
// 直接序列化会把 undefined/空串差异误判成脏，也会受对象键顺序影响。
const DRAFT_COMPARE_FIELDS = [
  "name",
  "scope",
  "storageLevel",
  "type",
  "command",
  "args",
  "env",
  "url",
  "headers",
  "timeoutMs",
  "oauth",
  "protocolVersion",
] as const satisfies readonly (keyof FormState)[];

export function isMcpFormDraftDirty(draft: FormState, baseline: FormState): boolean {
  return DRAFT_COMPARE_FIELDS.some((field) => (draft[field] ?? "") !== (baseline[field] ?? ""));
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** env/headers 在 schema 里是 Record<string, string>，值不是字符串时保存会被静默丢掉。 */
function validateStringRecordDraft(value: string): string | undefined {
  if (!value.trim()) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return "settings.mcp.form.validation.jsonInvalid";
  }
  if (!isJsonObject(parsed)) {
    return "settings.mcp.form.validation.jsonObjectRequired";
  }
  if (Object.values(parsed).some((entry) => typeof entry !== "string")) {
    return "settings.mcp.form.validation.jsonStringValues";
  }
  return undefined;
}

/** oauth 结构由 shared 的 McpOAuthConfig 定义，表单只要求它仍是 JSON 对象。 */
function validateJsonObjectDraft(value: string): string | undefined {
  if (!value.trim()) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return "settings.mcp.form.validation.jsonInvalid";
  }
  return isJsonObject(parsed) ? undefined : "settings.mcp.form.validation.jsonObjectRequired";
}

function validateUrlDraft(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return "settings.mcp.form.validation.urlRequired";
  }
  try {
    const parsed = new URL(trimmed);
    // MCP 的 HTTP/SSE 传输只接受 http(s)；自定义协议连不上还会把错误留到连接阶段。
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? undefined
      : "settings.mcp.form.validation.urlInvalid";
  } catch {
    return "settings.mcp.form.validation.urlInvalid";
  }
}

function validateTimeoutDraft(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  // 与 formToConfig 的 parseTimeoutMs 保持一致：非正数/小数都不落盘，
  // 但草稿阶段必须显式报错，不能等保存后才发现超时被忽略。
  return Number.isInteger(parsed) && parsed > 0
    ? undefined
    : "settings.mcp.form.validation.timeoutInvalid";
}

/**
 * 草稿阶段的 schema 校验。只校验当前传输类型真正会写盘的字段：
 * 例如把 stdio 切成 http 后，遗留的 env 文本不会进入 config，也不该阻止保存。
 */
export function validateMcpFormDraft(form: FormState): McpDraftValidation {
  const errors: McpDraftErrors = {};

  if (!form.name.trim()) {
    errors.name = "settings.mcp.form.validation.nameRequired";
  }

  const timeoutError = validateTimeoutDraft(form.timeoutMs);
  if (timeoutError) {
    errors.timeoutMs = timeoutError;
  }

  if (form.type === "stdio") {
    if (!form.command.trim()) {
      errors.command = "settings.mcp.form.validation.commandRequired";
    }
    const envError = validateStringRecordDraft(form.env);
    if (envError) {
      errors.env = envError;
    }
  } else {
    const urlError = validateUrlDraft(form.url);
    if (urlError) {
      errors.url = urlError;
    }
    const headersError = validateStringRecordDraft(form.headers);
    if (headersError) {
      errors.headers = headersError;
    }
    const oauthError = validateJsonObjectDraft(form.oauth ?? "");
    if (oauthError) {
      errors.oauth = oauthError;
    }
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

/** JSON 编辑模式下把解析异常归一成 i18n messageId；未知异常仍按 JSON 解析失败处理。 */
export function resolveMcpDraftErrorId(error: unknown): string {
  return error instanceof McpJsonDraftError ? error.messageId : "settings.mcp.form.jsonParseError";
}
