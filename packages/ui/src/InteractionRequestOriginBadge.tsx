import type { NibiInteractionRequestOrigin } from "@nibi/shared";
import { cn } from "@/components/lib/utils.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";

export function InteractionRequestOriginBadge({
  className,
  origin,
}: {
  className?: string;
  origin?: NibiInteractionRequestOrigin;
}) {
  const { intl } = useNibiIntl();
  if (origin?.kind !== "subagent") {
    return null;
  }

  // description 点名是哪个子代理在问（动态工作流子代理为 `<名字> (<siteId>@<ordinal>)`，
  // docs/dynamic-workflow/launch.md「Permissions inside a run」）；徽标截断，完整文本留在 tooltip。
  const description = origin.description?.trim();
  const label = description
    ? intl.formatMessage({ id: "chat.interactionOrigin.subagent.named" }, { description })
    : intl.formatMessage({ id: "chat.interactionOrigin.subagent" });
  const title = !origin.agentType
    ? label
    : description
      ? intl.formatMessage(
          { id: "chat.interactionOrigin.subagent.titleNamed" },
          { agentType: origin.agentType, description },
        )
      : intl.formatMessage(
          { id: "chat.interactionOrigin.subagent.title" },
          { agentType: origin.agentType },
        );

  return (
    // 来源说明从标题旁的小胶囊改为整行次级描述：长名字（含 siteId/ordinal）可折行，
    // 不再被 max-w-40 + truncate 截断。basis-full 让它在 flex 标题行里另起一行。
    <span
      title={title}
      data-interaction-origin-badge="subagent"
      className={cn(
        "block w-full min-w-0 basis-full whitespace-normal text-ui-base font-normal text-foreground-subtle [overflow-wrap:anywhere]",
        className,
      )}
    >
      {label}
    </span>
  );
}
