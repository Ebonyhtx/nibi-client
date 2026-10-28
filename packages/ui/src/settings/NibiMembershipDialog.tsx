import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2Icon, LogInIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import nibiIcon from "@/assets/nibi/nibi-app-icon.png";
import { useOAuth } from "@/hooks/useOAuth.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import {
  nibiMembershipAllowsPaidPlugins,
  resolveNibiMembershipPhase,
} from "@/settings/nibiMembershipState.js";
import { notifyNibiMembershipInvalidated } from "@/settings/useNibiMembership.js";
import {
  NIBI_MEMBERSHIP_WEBVIEW_PARTITION,
  NibiMembershipWebviewChannels,
  type NibiMembershipPurchaseCompletePayload,
} from "@nibi/shared";

/** 会员页站点（未带 handoff 时的兜底地址；实际由 host 换码后给出）。 */
export const NIBI_MEMBERSHIP_URL = "https://nibistudio.top/membership/?embedded=app";

/**
 * 收银台失败文案收敛：原始错误（含 HTTP 状态码、服务端术语）只进日志；
 * 界面只给用户能照着做的两类：会话失效 / 暂时打不开。
 */
function resolveCheckoutErrorCopy(
  intl: ReturnType<typeof useZCodeIntl>["intl"],
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  logger.warn("[membership] checkout failed", { message });
  if (/登录凭证缺失|请先在客户端登录|请重新登录/i.test(message)) {
    return intl.formatMessage({ id: "nibi.membership.dialog.sessionExpired" });
  }
  return intl.formatMessage({ id: "nibi.membership.dialog.openFailed" });
}

/** 与封禁提示文案中的邮箱保持一致，用于高亮和单击选中。 */
const NIBI_SUPPORT_EMAIL = "contact@nibistudio.top";

type Phase = "checking" | "login" | "loading" | "ready" | "error" | "banned";

export function NibiMembershipDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // 只在真正打开时挂载内容：内容里要用 services / platform，测试里渲染关闭态不触发。
  if (!open) return null;
  return createPortal(
    <MembershipDialogContent onClose={() => onOpenChange(false)} />,
    document.body,
  );
}

function MembershipDialogContent({ onClose }: { onClose: () => void }) {
  const { intl } = useZCodeIntl();
  const { oauthService } = useServices();
  const { startLogin, status: loginStatus } = useOAuth();
  const webviewRef = useRef<ElectronWebviewTag | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  // 回调保持稳定：webview 的 ref 回调不能每次 render 换新，否则会 detach/re-attach。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const oauthServiceRef = useRef(oauthService);
  oauthServiceRef.current = oauthService;
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [phase, setPhase] = useState<Phase>("checking");
  const [error, setError] = useState("");
  const [checkoutUrl, setCheckoutUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [purchaseComplete, setPurchaseComplete] = useState(false);
  // 购买完成后的会员状态强制同步：只有确认拿到可用会员才自动关闭；
  // 失败必须停在可重试状态，不能"看着像成功了"其实付费插件还被门禁挡着。
  const [purchaseSync, setPurchaseSync] = useState<"idle" | "syncing" | "failed">("idle");

  const syncMembershipAfterPurchase = useCallback(async () => {
    setPurchaseSync("syncing");
    try {
      const status = await oauthServiceRef.current.getNibiMembershipStatus({ force: true });
      notifyNibiMembershipInvalidated();
      const allowed =
        status.loggedIn &&
        status.membership !== null &&
        nibiMembershipAllowsPaidPlugins(resolveNibiMembershipPhase(status));
      if (allowed) {
        setPurchaseSync("idle");
        if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
        closeTimerRef.current = setTimeout(() => onCloseRef.current(), 1500);
      } else {
        setPurchaseSync("failed");
      }
    } catch {
      // 网络失败/服务端 5xx：保留弹窗与错误态，用户点重试再走 force check。
      setPurchaseSync("failed");
    }
  }, []);

  const attachWebview = useCallback((node: ElectronWebviewTag | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    webviewRef.current = node;
    if (!node) return;
    const handleReady = () => {
      setLoading(false);
      setLoadError(null);
    };
    const handleStart = () => setLoading(true);
    const handleFail = (event: Event) => {
      const detail = event as unknown as { errorDescription?: string; isMainFrame?: boolean };
      if (detail.isMainFrame === false) return;
      setLoading(false);
      setLoadError(detail.errorDescription ?? "load_failed");
    };
    // 会员页 preload 通过 ipc-message 回传购买完成；payload 必须是我们自己的会员商品，
    // 伪造/脏数据一律忽略。收到后强制在线刷新会员状态（/licenses/check），
    // 广播给所有消费点；确认生效才自动关闭，失败停在可重试状态。
    const handleIpcMessage = (event: ElectronWebviewIpcMessageEvent) => {
      if (event.channel !== NibiMembershipWebviewChannels.PurchaseComplete) return;
      const payload = event.args[0] as NibiMembershipPurchaseCompletePayload | undefined;
      if (payload?.provider !== "nibi") return;
      setPurchaseComplete(true);
      void syncMembershipAfterPurchase();
    };
    node.addEventListener("dom-ready", handleReady);
    node.addEventListener("did-start-loading", handleStart);
    node.addEventListener("did-fail-load", handleFail);
    node.addEventListener("ipc-message", handleIpcMessage);
    cleanupRef.current = () => {
      node.removeEventListener("dom-ready", handleReady);
      node.removeEventListener("did-start-loading", handleStart);
      node.removeEventListener("did-fail-load", handleFail);
      node.removeEventListener("ipc-message", handleIpcMessage);
    };
  }, [syncMembershipAfterPurchase]);

  useEffect(
    () => () => {
      cleanupRef.current?.();
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    },
    [],
  );

  const openCheckout = useCallback(async () => {
    setPhase("loading");
    setError("");
    try {
      const { url } = await oauthService.createNibiCheckoutUrl();
      setCheckoutUrl(url);
      setPhase("ready");
    } catch (err) {
      if ((err as { code?: string } | null)?.code === "account_banned") {
        setPhase("banned");
        return;
      }
      setError(resolveCheckoutErrorCopy(intl, err));
      setPhase("error");
    }
  }, [intl, oauthService]);

  const checkSession = useCallback(async () => {
    setPhase("checking");
    setError("");
    try {
      const status = await oauthService.getNibiMembershipStatus();
      if (!status.loggedIn) {
        setPhase("login");
        return;
      }
      await openCheckout();
    } catch (err) {
      setError(resolveCheckoutErrorCopy(intl, err));
      setPhase("error");
    }
  }, [intl, oauthService, openCheckout]);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  // 未登录：等客户端登录完成（deep link 回来后 active provider 变为 nibi）。
  useEffect(() => {
    if (phase !== "login") return;
    const timer = setInterval(() => {
      void (async () => {
        const status = await oauthService.getNibiMembershipStatus();
        if (status.loggedIn) {
          clearInterval(timer);
          notifyNibiMembershipInvalidated();
          await openCheckout();
        }
      })().catch(() => {
        // 轮询失败继续等下一次。
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [phase, oauthService, openCheckout]);

  /**
   * 关闭前清掉 webview 的站点会话 Cookie（HttpOnly，页面自己读不到，只能让页面发请求清）。
   * 等最多 800ms，避免 executeJavaScript 卡住把弹窗关不掉。
   */
  const closeDialog = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview || phase !== "ready") {
      onClose();
      return;
    }
    const script =
      "fetch('https://api.nibistudio.top/api/v1/auth/session/logout',{method:'POST',credentials:'include',headers:{'X-Nibi-Session':'1'}}).then(()=>true).catch(()=>false)";
    const done = Promise.resolve()
      .then(() => webview.executeJavaScript(script, true))
      .catch(() => undefined);
    void Promise.race([done, new Promise((resolve) => setTimeout(resolve, 800))]).finally(() =>
      onClose(),
    );
  }, [onClose, phase]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDialog();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDialog]);

  const reload = () => {
    setLoadError(null);
    setLoading(true);
    // handoff 码是一次性的：刷新必须重新换码，不能 reload 旧 URL。
    void openCheckout();
  };

  const bannedHint = intl.formatMessage({ id: "nibi.membership.dialog.bannedHint" });
  const bannedEmailAt = bannedHint.indexOf(NIBI_SUPPORT_EMAIL);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      data-testid="nibi-membership-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeDialog();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={intl.formatMessage({ id: "settings.plugins.membership.title" })}
        className="flex h-[min(760px,88vh)] w-full max-w-[1000px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
      >
        <header className="flex items-start gap-3 border-b border-border px-5 py-4">
          <img
            src={nibiIcon}
            alt=""
            aria-hidden="true"
            className="size-9 rounded-xl object-contain"
          />
          <div className="min-w-0 flex-1">
            <h2 className="text-ui-lg font-semibold text-foreground">
              {intl.formatMessage({ id: "settings.plugins.membership.title" })}
            </h2>
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "nibi.membership.dialog.subtitle" })}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              aria-label={intl.formatMessage({ id: "nibi.membership.dialog.refresh" })}
              onClick={reload}
              disabled={phase !== "ready"}
            >
              <RefreshCwIcon className="size-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              aria-label={intl.formatMessage({ id: "nibi.membership.dialog.close" })}
              onClick={closeDialog}
            >
              <XIcon className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </header>

        <div className="relative min-h-0 flex-1 bg-background">
          {phase === "checking" || phase === "loading" ? (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-ui-base text-foreground-subtle">
              <Loader2Icon className="size-5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "nibi.membership.dialog.loading" })}
            </div>
          ) : null}

          {phase === "login" ? (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 p-8 text-center">
              <img
                src={nibiIcon}
                alt=""
                aria-hidden="true"
                className="size-14 rounded-2xl object-contain"
              />
              <div className="max-w-md space-y-1.5">
                <p className="text-ui-base font-semibold text-foreground">
                  {intl.formatMessage({ id: "nibi.membership.dialog.loginRequired" })}
                </p>
                <p className="text-ui-sm text-foreground-subtle">
                  {intl.formatMessage({ id: "nibi.membership.dialog.loginRequiredHint" })}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                disabled={loginStatus === "waiting"}
                onClick={() => void startLogin("nibi")}
              >
                {loginStatus === "waiting" ? (
                  <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <LogInIcon className="size-3.5" aria-hidden="true" />
                )}
                {intl.formatMessage({ id: "nibi.membership.dialog.loginButton" })}
              </Button>
              {loginStatus === "error" ? (
                <p className="text-ui-sm text-destructive">
                  {intl.formatMessage({ id: "login.oauth.loginFailure" })}
                </p>
              ) : null}
            </div>
          ) : null}

          {phase === "banned" ? (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 p-8 text-center">
              <img
                src={nibiIcon}
                alt=""
                aria-hidden="true"
                className="size-14 rounded-2xl object-contain"
              />
              <p className="text-ui-base font-semibold text-foreground">
                {intl.formatMessage({ id: "nibi.membership.dialog.bannedTitle" })}
              </p>
              <p className="max-w-md text-balance text-ui-sm text-foreground-subtle">
                {bannedEmailAt >= 0 ? (
                  <>
                    {bannedHint.slice(0, bannedEmailAt)}
                    <span className="select-all font-medium text-foreground">
                      {NIBI_SUPPORT_EMAIL}
                    </span>
                    {bannedHint.slice(bannedEmailAt + NIBI_SUPPORT_EMAIL.length)}
                  </>
                ) : (
                  bannedHint
                )}
              </p>
              <Button type="button" size="sm" variant="outline" onClick={closeDialog}>
                {intl.formatMessage({ id: "nibi.membership.dialog.close" })}
              </Button>
            </div>
          ) : null}

          {phase === "error" ? (
            <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-ui-base font-medium text-foreground">
                {intl.formatMessage({ id: "nibi.membership.dialog.loadError" })}
              </p>
              <p className="text-ui-sm text-foreground-subtle">{error}</p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void checkSession()}
                >
                  <RefreshCwIcon className="size-3.5" aria-hidden="true" />
                  {intl.formatMessage({ id: "nibi.membership.dialog.retry" })}
                </Button>
              </div>
            </div>
          ) : null}

          {phase === "ready" ? (
            <>
              {purchaseComplete ? (
                <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-background/95 p-8 text-center">
                  <p className="text-ui-base font-semibold text-foreground">
                    {intl.formatMessage({ id: "nibi.membership.dialog.purchaseComplete" })}
                  </p>
                  {purchaseSync === "syncing" ? (
                    <p className="flex items-center gap-2 text-ui-sm text-foreground-subtle">
                      <Loader2Icon className="size-3.5 animate-spin" aria-hidden="true" />
                      {intl.formatMessage({ id: "nibi.membership.dialog.purchaseSyncing" })}
                    </p>
                  ) : null}
                  {purchaseSync === "failed" ? (
                    <>
                      <p className="max-w-md text-ui-sm text-destructive">
                        {intl.formatMessage({ id: "nibi.membership.dialog.purchaseSyncFailed" })}
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => void syncMembershipAfterPurchase()}
                      >
                        <RefreshCwIcon className="size-3.5" aria-hidden="true" />
                        {intl.formatMessage({ id: "nibi.membership.dialog.retry" })}
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : null}
              {loading && !loadError ? (
                <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 text-ui-base text-foreground-subtle">
                  <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
                  {intl.formatMessage({ id: "nibi.membership.dialog.loading" })}
                </div>
              ) : null}
              {loadError ? (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 p-6 text-center">
                  <p className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({ id: "nibi.membership.dialog.loadError" })}
                  </p>
                  <p className="text-ui-sm text-foreground-subtle">{loadError}</p>
                  <Button type="button" size="sm" variant="ghost" onClick={reload}>
                    <RefreshCwIcon className="size-3.5" aria-hidden="true" />
                    {intl.formatMessage({ id: "nibi.membership.dialog.retry" })}
                  </Button>
                </div>
              ) : null}
              <webview
                key={checkoutUrl}
                ref={attachWebview}
                allowpopups={"" as unknown as boolean}
                partition={NIBI_MEMBERSHIP_WEBVIEW_PARTITION}
                src={checkoutUrl}
                className={cn(
                  "h-full w-full bg-background [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
                  (loading || loadError) && "invisible",
                )}
                data-testid="nibi-membership-webview"
              />
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}
