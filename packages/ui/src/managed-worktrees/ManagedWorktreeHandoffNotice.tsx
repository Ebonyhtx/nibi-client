// 会话已打开、首份 snapshot 尚未到达时的轻量占位提示。
// 不拦截点击、不抢焦点；timeline 一有行就由父组件换掉它。
import { LoaderCircle } from "lucide-react";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { TID_WORKTREE_HANDOFF } from "./testIds.js";

export function ManagedWorktreeHandoffNotice() {
  const { intl } = useNibiIntl();
  return (
    <div
      data-testid={TID_WORKTREE_HANDOFF}
      role="status"
      aria-live="polite"
      className="flex h-full w-full flex-col items-center justify-center gap-2 py-16 text-ui-base text-foreground-subtle"
    >
      <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      <span>{intl.formatMessage({ id: "git.managedWorktree.creation.startingSession" })}</span>
    </div>
  );
}
