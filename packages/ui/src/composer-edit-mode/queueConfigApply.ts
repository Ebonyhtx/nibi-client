import { v4QueuedCommandText } from "@/v4/slashCommands.js";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import type { QueueItem } from "@nibi/shared/nibi-protocol-v4";

import type { ComposerEditConfig, ComposerEditDraft } from "./contract.js";

/**
 * 队列项里的配置（模式/Plan/模型）在选择编辑时冻结，由编辑态 Composer 展示与携带，
 * 不因编辑期间用户切换工具栏而改写队列项；v1 内核只回写正文。
 */
export function resolveQueueEditConfig(
  item: Pick<QueueItem, "mode" | "planEnabled" | "modelSelection">,
): ComposerEditConfig {
  return {
    ...(item.mode ? { mode: item.mode } : {}),
    ...(typeof item.planEnabled === "boolean" ? { planEnabled: item.planEnabled } : {}),
    ...(item.modelSelection ? { modelSelection: item.modelSelection } : {}),
  };
}

/** compact 队列项没有可编辑正文；返回 null 让入口保持禁用。 */
export function resolveQueueItemEditDraft(item: QueueItem): ComposerEditDraft | null {
  if (item.kind === "compact") return null;
  const config = resolveQueueEditConfig(item);
  return {
    text: v4QueuedCommandText(item.kind, item.text),
    attachments: item.attachments.map((attachment) => ({ ...attachment })),
    config,
  };
}

/**
 * 把编辑态冻结配置写进 Composer 草稿对象，供工具栏显示；不写回会话草稿。
 */
export function applyQueueEditConfigToComposerDraft(
  draft: V4ComposerDraft,
  config: ComposerEditConfig | undefined,
): V4ComposerDraft {
  if (!config) return draft;
  return {
    ...draft,
    ...(config.mode ? { mode: config.mode } : {}),
    ...(typeof config.planEnabled === "boolean" ? { planEnabled: config.planEnabled } : {}),
    ...(config.modelSelection ? { modelSelection: config.modelSelection } : {}),
  };
}
