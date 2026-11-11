import type { ClientSceneConfig, ClientSceneItem } from "@nibi/services";

export interface DraftSuggestedPromptLocalizedText {
  cn?: string;
  en?: string;
}

export const DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS = "NAVIGATE:AUTOMATIONS" as const;

export type DraftSuggestedPromptAction = typeof DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS;

export interface DraftSuggestedPromptItem {
  id: string;
  /** Lucide canonical 名称，只来自 ClientSceneItem.img；不使用 imgs。 */
  iconName?: string;
  /** 官方推荐项的市场图标。 */
  iconUrl?: string;
  /** 复用插件市场图标的展示样式，不代表绑定插件。 */
  iconStyle?: "plugin";
  label: DraftSuggestedPromptLocalizedText;
  /** 可选描述；统一卡片只在存在有效文案时渲染第二行。 */
  description?: DraftSuggestedPromptLocalizedText;
  prompt: DraftSuggestedPromptLocalizedText;
  actions?: DraftSuggestedPromptAction[];
  plugin?: {
    stableId: string;
    label: DraftSuggestedPromptLocalizedText;
  };
}

export function parseDraftSuggestedPromptActions(
  onFinish: string | null | undefined,
): DraftSuggestedPromptAction[] {
  if (!onFinish) return [];

  const actions: DraftSuggestedPromptAction[] = [];
  for (const token of onFinish.split(",")) {
    switch (token.trim()) {
      case DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS:
        if (!actions.includes(DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS)) {
          actions.push(DRAFT_SUGGESTED_PROMPT_NAVIGATE_AUTOMATIONS);
        }
        break;
      default:
        break;
    }
  }
  return actions;
}

function findDefaultItem(
  scene: ClientSceneConfig,
  promptItem: ClientSceneItem,
): ClientSceneItem | undefined {
  for (const [optionKey, itemIds] of Object.entries(promptItem.defaults ?? {})) {
    const optionItems = scene.options[optionKey]?.items;
    if (!optionItems) continue;
    for (const itemId of itemIds) {
      const item = optionItems.find((candidate) => candidate.id === itemId);
      if (item) return item;
    }
  }
  return undefined;
}

export function mapClientScenesToDraftSuggestedPromptItems(
  scenes: readonly ClientSceneConfig[],
): DraftSuggestedPromptItem[] {
  const scene = scenes.find((candidate) => candidate.scene === "draft-suggestion");
  const promptItems = scene?.options.prompts?.items;
  if (!scene || !promptItems) return [];

  return promptItems.map((item) => {
    const defaultItem = findDefaultItem(scene, item);
    const actions = parseDraftSuggestedPromptActions(item.on_finish);
    // Scene 下发的 stableId 只是候选，渲染前仍会按 Host 已安装 catalog 过滤；
    // 不能因为文案里写了一个 id 就当成当前安装可用的 Plugin。
    const stableId = defaultItem?.contents.en?.trim() || defaultItem?.contents.cn?.trim();
    const descriptionCn = item.descs?.cn?.trim();
    const descriptionEn = item.descs?.en?.trim();
    return {
      id: item.id,
      ...(item.img?.trim() ? { iconName: item.img.trim() } : {}),
      label: item.labels,
      ...(descriptionCn || descriptionEn
        ? {
            description: {
              ...(descriptionCn ? { cn: descriptionCn } : {}),
              ...(descriptionEn ? { en: descriptionEn } : {}),
            },
          }
        : {}),
      prompt: item.contents,
      ...(actions.length > 0 ? { actions } : {}),
      ...(defaultItem && stableId
        ? {
            plugin: {
              stableId,
              label: defaultItem.labels,
            },
          }
        : {}),
    };
  });
}

export function resolveDraftSuggestedPromptText(
  text: DraftSuggestedPromptLocalizedText,
  locale: string,
): string {
  const primary = locale.startsWith("zh") ? text.cn : text.en;
  const fallback = locale.startsWith("zh") ? text.en : text.cn;
  return primary?.trim() || fallback?.trim() || "";
}

// 推荐卡正文里的插件引用可能和 item.plugin 不是同一个（例如一条 prompt 同时 @ 多个插件），
// 所以可用性过滤必须同时检查两处，不能只看结构化字段。
const PLUGIN_MENTION_PATTERN = /\(plugin:\/\/([^)\s]+)\)/g;

export function collectSuggestedPromptPluginIds(item: DraftSuggestedPromptItem): string[] {
  const ids = new Set<string>();
  if (item.plugin?.stableId.trim()) ids.add(item.plugin.stableId.trim());
  for (const prompt of [item.prompt.cn, item.prompt.en]) {
    if (!prompt) continue;
    for (const match of prompt.matchAll(PLUGIN_MENTION_PATTERN)) {
      const stableId = match[1]?.trim();
      if (stableId) ids.add(stableId);
    }
  }
  return [...ids];
}

/**
 * 按运行期已安装 Plugin 目录过滤推荐卡。
 *
 * 根因：推荐语料曾引用官方市场并不存在的 `lark-cli@nibi-official`，用户点进去只能反复
 * 触发刷新/安装失败。只在文案层删掉不够 —— Client Scenes 仍可能下发旧插件 id，后续语料
 * 也可能再次漂移，所以这里用 Host 返回的真实 catalog 做最后一道运行时过滤。
 *
 * `availablePluginIds === null` 表示目录尚未就绪（加载中或查询失败）。此时放行而不是清空，
 * 避免一次慢请求/离线把整块推荐区闪没；插件引用被删干净后，干净安装也不会再命中缺失项。
 */
export function filterSuggestedPromptItemsByPluginAvailability(
  items: readonly DraftSuggestedPromptItem[],
  availablePluginIds: ReadonlySet<string> | null,
): DraftSuggestedPromptItem[] {
  if (availablePluginIds === null) return [...items];
  return items.filter((item) =>
    collectSuggestedPromptPluginIds(item).every((stableId) => availablePluginIds.has(stableId)),
  );
}

/**
 * Client Scenes 明确返回 404（服务端尚未提供 draft-suggestion）时的本地兜底。
 *
 * 根因：此前 404 会让新建任务页的推荐区整块消失，而旧 officeSuggestedPrompts 里的
 * `defaultSuggestedPrompts` 从未被任何代码引用。这里只保留不依赖任何 Plugin 的通用任务：
 * 卡片正文不得出现 `plugin://`，否则干净安装会再次出现“点了没有插件”的死路。
 */
export const draftSuggestedPromptFallback: DraftSuggestedPromptItem[] = [
  {
    id: "fallback-disk-usage",
    iconName: "hard-drive",
    label: {
      cn: "帮我看看电脑空间主要被什么占满了",
      en: "Show what is using up space on my computer",
    },
    prompt: {
      cn: "帮我看看这台电脑的磁盘空间主要被什么占用了。先说明你检查了哪些目录，再按占用大小列出主要目录和大文件，并给出安全的清理建议；不要删除或移动任何文件。",
      en: "Show me what is using up disk space on this computer. Explain which folders you inspected, list the largest directories and files, and suggest safe clean-up options. Do not delete or move any files.",
    },
  },
  {
    id: "fallback-today-plan",
    iconName: "list-todo",
    label: {
      cn: "帮我梳理今天要做的事并排出优先级",
      en: "Help me plan today's work by priority",
    },
    prompt: {
      cn: "帮我梳理今天要做的事并排出优先级。先问我有哪些待办或截止时间；如果我没有提供，就先列出需要我补充的信息，不要凭空编造任务。最后给出最值得先做的三件事和理由。",
      en: "Help me organize today's work and prioritize it. Ask me for my to-dos or deadlines first; if I do not provide any, list what you need from me instead of inventing tasks. Finish with the three things I should do first and why.",
    },
  },
  {
    id: "fallback-recent-changes",
    iconName: "git-branch",
    label: {
      cn: "帮我检查当前仓库最近的改动",
      en: "Review recent changes in the current repository",
    },
    prompt: {
      cn: "帮我看看当前仓库最近的改动有哪些值得关注。先确认当前分支和目标分支；如果当前没有打开仓库，先让我选择一个。说明主要改动、可能的风险和验证情况，不要修改代码。",
      en: "Review recent changes in the current repository and highlight what matters. Confirm the current and target branches first; if no repository is open, ask me to choose one. Explain the main changes, possible risks, and what was verified. Do not modify code.",
    },
  },
];
