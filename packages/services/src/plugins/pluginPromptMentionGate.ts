// 插件引用（`[@Plugin](plugin://stable-id)`）的发送侧兜底门禁。
//
// 为什么需要这一层：商店「立即试用」只是在 Composer 里预填一个 canonical Plugin mention，
// 真正的发送发生在会话 `sendText` / `session/send`。UI 层的可用性判断（按钮置灰、先启用再试用、
// 会员引导）都是体验层，一旦被绕过（旧 UI、快捷键、远控命令、脚本），一条带未启用插件引用的
// 消息仍会被送进会话：模型看不到该插件的 MCP/Skill，却会按 prompt 去调用，最终表现为
// ListMcpResourcesTool 失败、终端翻插件目录。因此发送入口必须独立复核插件当前是否可用。
//
// 判定口径与宿主运行时一致：`plugins/referenceCatalog` 的 `enabled` 已经把「手动停用」和
// 「付费插件缺少/过期会员」合并成同一个结论（发现层门禁被拒即按未启用处理），
// 所以只需校验 enabled；目录里查不到的 stable id 视为未安装/不可用。

/** 与 Composer/Agent 共用的 canonical Plugin stable id 形态：`<name>@<marketplace>`。 */
const PLUGIN_STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*$/u;

/** 只提取合法 destination；label 仅展示，不作为身份来源。 */
export const PLUGIN_MENTION_DESTINATION_PATTERN =
  /plugin:\/\/([A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*)/gu;

/** 插件引用 catalog 的最小投影，避免门禁依赖完整协议类型。 */
export interface PluginPromptMentionCatalogEntry {
  pluginId: string;
  name?: string;
  enabled: boolean;
}

export type PluginPromptMentionBlockReason = "plugin_not_enabled" | "plugin_not_installed";

export interface PluginPromptMentionBlocker {
  pluginId: string;
  name?: string;
  reason: PluginPromptMentionBlockReason;
}

export type PluginPromptMentionGateResult =
  | { allowed: true }
  | { allowed: false; blockers: PluginPromptMentionBlocker[] };

/** 提取消息里的 Plugin stable id，去重并保持出现顺序（同一插件被引用多次只校验一次）。 */
export function extractPluginMentionIds(content: string): string[] {
  if (!content.includes("plugin://")) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(PLUGIN_MENTION_DESTINATION_PATTERN)) {
    const candidate = match[1] ?? "";
    if (!PLUGIN_STABLE_ID_PATTERN.test(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    ids.push(candidate);
  }
  return ids;
}

export function resolvePluginPromptMentionGate(input: {
  pluginIds: readonly string[];
  entries: readonly PluginPromptMentionCatalogEntry[];
}): PluginPromptMentionGateResult {
  if (input.pluginIds.length === 0) return { allowed: true };
  const entryById = new Map(input.entries.map((entry) => [entry.pluginId, entry]));
  const blockers: PluginPromptMentionBlocker[] = [];
  for (const pluginId of input.pluginIds) {
    const entry = entryById.get(pluginId);
    if (!entry) {
      blockers.push({ pluginId, reason: "plugin_not_installed" });
      continue;
    }
    if (!entry.enabled) {
      blockers.push({
        pluginId,
        ...(entry.name ? { name: entry.name } : {}),
        reason: "plugin_not_enabled",
      });
    }
  }
  return blockers.length === 0 ? { allowed: true } : { allowed: false, blockers };
}

function formatBlockerLabel(blocker: PluginPromptMentionBlocker): string {
  return blocker.name && blocker.name !== blocker.pluginId
    ? `${blocker.name}（${blocker.pluginId}）`
    : (blocker.name ?? blocker.pluginId);
}

/** 明确告知用户「消息没有发出去」以及恢复路径，禁止静默丢弃。 */
export function formatPluginPromptMentionBlockMessage(
  blockers: readonly PluginPromptMentionBlocker[],
): string {
  const reasons = blockers.map((blocker) => {
    const label = formatBlockerLabel(blocker);
    return blocker.reason === "plugin_not_installed"
      ? `插件「${label}」未安装或当前不可用`
      : `插件「${label}」未启用（会员专享插件还需要有效的 NIBI 会员）`;
  });
  return `${reasons.join("；")}，消息未发送。请先在插件市场安装或启用该插件后重试。`;
}

/** 发送入口可识别的机器错误码，便于上层映射文案或埋点。 */
export const PLUGIN_PROMPT_MENTION_BLOCKED_CODE = "plugin_prompt_mention_blocked";

export class PluginPromptMentionBlockedError extends Error {
  readonly code = PLUGIN_PROMPT_MENTION_BLOCKED_CODE;
  readonly blockers: PluginPromptMentionBlocker[];

  constructor(blockers: PluginPromptMentionBlocker[]) {
    super(formatPluginPromptMentionBlockMessage(blockers));
    this.name = "PluginPromptMentionBlockedError";
    this.blockers = blockers;
  }
}

/**
 * 发送前复核：消息里没有 Plugin 引用时零开销；catalog 读取失败放行（旧 Host / 远端进程
 * 可能没有该只读方法，不能因为观测面缺失把所有含引用消息都拒掉），但**读到了且明确不可用**
 * 时必须拒绝。
 */
export async function assertPluginPromptMentionsUsable(input: {
  content: string;
  requestCatalog: () => Promise<{ plugins: readonly PluginPromptMentionCatalogEntry[] }>;
  onCatalogError?: (error: unknown) => void;
}): Promise<void> {
  const pluginIds = extractPluginMentionIds(input.content);
  if (pluginIds.length === 0) return;
  let entries: readonly PluginPromptMentionCatalogEntry[];
  try {
    entries = (await input.requestCatalog()).plugins;
  } catch (error) {
    input.onCatalogError?.(error);
    return;
  }
  const gate = resolvePluginPromptMentionGate({ pluginIds, entries });
  if (!gate.allowed) throw new PluginPromptMentionBlockedError(gate.blockers);
}
