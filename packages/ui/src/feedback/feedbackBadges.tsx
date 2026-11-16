import { useEffect, useState, type ReactNode } from "react";
import { AlertCircle, Loader2, LogInIcon } from "lucide-react";
import type { FeedbackTicketStatus } from "@nibi/shared";
import type { IFeedbackService } from "@nibi/services";
import { Button } from "@/components/ui/button.js";
import { useOAuth } from "@/hooks/useOAuth.js";
import { formatFeedbackStatusLabel, STATUS_META } from "@/feedback/feedbackMeta.js";
import { cn } from "@/components/lib/utils.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";

export function RequiredMarker() {
  // 两个反馈弹窗曾各自维护星号，导致读屏语义分叉；统一隐藏装饰符号，必填由输入框声明。
  return (
    <span aria-hidden="true" className="mr-1 text-destructive">
      *
    </span>
  );
}

export function StatusIndicator({
  status,
  withDot = true,
  children,
  className,
}: {
  status: FeedbackTicketStatus;
  withDot?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  const meta = STATUS_META[status];
  const { intl } = useNibiIntl();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-ui-base font-medium",
        meta.className,
        className,
      )}
    >
      {withDot ? <span className={cn("size-1.5 rounded-full", meta.dot)} /> : null}
      {children ?? formatFeedbackStatusLabel(status, intl.formatMessage)}
    </span>
  );
}

export function FeedbackErrorTip({ message }: { message: string }) {
  return (
    <div
      className="flex items-start gap-2 rounded-xl border border-red-500/25 bg-red-500/10 px-3 py-2 text-ui-base text-red-300"
      role="alert"
    >
      <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-red-400" />
      <span className="break-words leading-relaxed">{message}</span>
    </div>
  );
}

type FeedbackLoginState = "checking" | "loggedIn" | "loggedOut";

/**
 * 反馈 v2 的统一登录门禁：服务端拒绝匿名，客户端在打开表单/列表时先确认
 * oauth:nibi:access_token 存在。未登录时给出登录按钮，登录成功后自动放行。
 */
export function FeedbackLoginGate({
  feedbackService,
  children,
}: {
  feedbackService: IFeedbackService;
  children: ReactNode;
}) {
  const { intl } = useNibiIntl();
  const formatMessage = intl.formatMessage;
  const { startLogin, status: loginStatus } = useOAuth();
  const [state, setState] = useState<FeedbackLoginState>("checking");

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const loggedIn = await feedbackService.isLoggedIn();
        if (alive) setState(loggedIn ? "loggedIn" : "loggedOut");
      } catch {
        if (alive) setState("loggedOut");
      }
    };
    void check();
    if (state === "loggedIn") {
      return () => {
        alive = false;
      };
    }
    const timer = globalThis.setInterval(() => void check(), 2000);
    return () => {
      alive = false;
      globalThis.clearInterval(timer);
    };
  }, [feedbackService, state]);

  if (state === "loggedIn") return <>{children}</>;

  if (state === "checking") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center gap-2 p-8 text-ui-base text-foreground-subtle">
        <Loader2 className="size-4 animate-spin text-primary" />
        {formatMessage({ id: "feedback.login.checking" })}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <LogInIcon className="size-8 text-foreground-subtle" aria-hidden="true" />
      <div className="max-w-sm space-y-1.5">
        <p className="text-ui-base font-semibold text-foreground">
          {formatMessage({ id: "feedback.login.requiredTitle" })}
        </p>
        <p className="text-ui-sm text-foreground-subtle">
          {formatMessage({ id: "feedback.login.requiredHint" })}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        disabled={loginStatus === "waiting"}
        onClick={() => void startLogin("nibi")}
      >
        {loginStatus === "waiting" ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <LogInIcon className="size-3.5" aria-hidden="true" />
        )}
        {formatMessage({ id: "feedback.login.button" })}
      </Button>
      {loginStatus === "error" ? (
        <p className="text-ui-sm text-destructive">
          {formatMessage({ id: "feedback.login.failed" })}
        </p>
      ) : null}
    </div>
  );
}
