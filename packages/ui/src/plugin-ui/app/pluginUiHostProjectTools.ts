import type { PluginProjectSyncRequest } from "@nibi/services";

/**
 * 面板调用宿主云端能力的保留工具名。
 *
 * 为什么走 `tools/call` 而不是新开一条页面通道：面板本来就只会 `callTool`（它连的是自己的
 * MCP server）；这些名字在 AppBridge 的 handler 里被宿主拦截，**不会**转发给插件 server，
 * 因此插件进程既拿不到登录令牌，也不能替别的插件/工作区发起请求。
 */
export const HOST_PROJECT_TOOL_PREFIX = "nibi_cloud_";

const ACTIONS = {
  nibi_cloud_list: "list",
  nibi_cloud_create: "create",
  nibi_cloud_join: "join",
  nibi_cloud_status: "status",
  nibi_cloud_version: "version",
  nibi_cloud_upload: "upload",
  nibi_cloud_pull: "pull",
  nibi_cloud_resolve: "resolve",
} as const;

export type HostProjectToolName = keyof typeof ACTIONS;

export type HostProjectToolParse =
  | { request: PluginProjectSyncRequest }
  | { error: string };

function text(args: Record<string, unknown>, key: string, label: string, max: number): string {
  const value = args[key];
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new Error(`请填写${label}`);
  if (trimmed.length > max) throw new Error(`${label}过长（最多 ${max} 个字符）`);
  return trimmed;
}

function requiredText(
  args: Record<string, unknown>,
  key: string,
  label: string,
  max: number,
): { value: string } | { error: string } {
  try {
    return { value: text(args, key, label, max) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * `null` = 不是保留名，按普通插件工具转发；`{error}` = 保留名但参数不合法，
 * 由宿主直接回错误，避免插件 server 抢注同名工具或拿到半解析参数。
 */
export function parseHostProjectToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
): HostProjectToolParse | null {
  if (!Object.prototype.hasOwnProperty.call(ACTIONS, name)) {
    return name.startsWith(HOST_PROJECT_TOOL_PREFIX)
      ? { error: `未知的云端操作：${name}` }
      : null;
  }
  const action = ACTIONS[name as HostProjectToolName];
  const values = args ?? {};
  switch (action) {
    case "list":
      return { request: { action: "list" } };
    case "create": {
      const nameValue = requiredText(values, "name", "项目名称", 80);
      return "error" in nameValue
        ? { error: nameValue.error }
        : { request: { action: "create", name: nameValue.value } };
    }
    case "join": {
      const inviteCode = requiredText(values, "inviteCode", "邀请码", 64);
      return "error" in inviteCode
        ? { error: inviteCode.error }
        : { request: { action: "join", inviteCode: inviteCode.value } };
    }
    case "status": {
      const projectId = requiredText(values, "projectId", "项目 ID", 128);
      return "error" in projectId
        ? { error: projectId.error }
        : { request: { action: "status", projectId: projectId.value } };
    }
    case "version": {
      const projectId = requiredText(values, "projectId", "项目 ID", 128);
      if ("error" in projectId) return { error: projectId.error };
      const revision = values.revision;
      if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
        return { error: "版本号必须是正整数" };
      }
      return { request: { action: "version", projectId: projectId.value, revision } };
    }
    case "upload": {
      const projectId = requiredText(values, "projectId", "项目 ID", 128);
      if ("error" in projectId) return { error: projectId.error };
      const rawMessage = values.message;
      if (rawMessage !== undefined && typeof rawMessage !== "string") {
        return { error: "提交说明必须是文本" };
      }
      const message = rawMessage?.trim();
      return {
        request: {
          action: "upload",
          projectId: projectId.value,
          ...(message ? { message: message.slice(0, 500) } : {}),
        },
      };
    }
    case "pull": {
      const projectId = requiredText(values, "projectId", "项目 ID", 128);
      return "error" in projectId
        ? { error: projectId.error }
        : { request: { action: "pull", projectId: projectId.value } };
    }
    case "resolve": {
      const projectId = requiredText(values, "projectId", "项目 ID", 128);
      if ("error" in projectId) return { error: projectId.error };
      const revision = values.revision;
      if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) {
        return { error: "草稿版本号必须是正整数" };
      }
      const rawChoices = values.choices;
      if (
        rawChoices === null ||
        typeof rawChoices !== "object" ||
        Array.isArray(rawChoices)
      ) {
        return { error: "choices 必须是逐文件选择对象" };
      }
      const choices: Record<string, "ours" | "theirs"> = {};
      for (const [path, choice] of Object.entries(rawChoices)) {
        if (!path || (choice !== "ours" && choice !== "theirs")) {
          return { error: `冲突选择无效：${path || "(空路径)"}` };
        }
        choices[path] = choice;
      }
      if (Object.keys(choices).length === 0) {
        return { error: "至少选择一个文件" };
      }
      return {
        request: {
          action: "resolve",
          projectId: projectId.value,
          revision,
          choices,
        },
      };
    }
  }
}
