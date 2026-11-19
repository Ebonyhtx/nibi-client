import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2Icon, XIcon } from "lucide-react";
import { NIBI_MEMBERSHIP_WEBVIEW_PARTITION } from "@nibi/shared";
import { Button } from "@/components/ui/button.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";

const OAUTH_CALLBACK_PREFIX = "nibi://oauth/callback";

/**
 * 客户端内嵌 OAuth WebView：桌面主登录页使用。
 *
 * 授权页仍是 auth.nibistudio.cn（Zitadel + 自建登录 UI），所以注册、登录、邮箱验证、
 * 找回密码全部沿用现有页面；这里只负责把 WebView 拦到的 nibi:// 回调交回 Main，
 * 由 Main 走与系统 deep link 相同的路由，Root 的 OAuth 监听器照常完成登录。
 *
 * partition 复用会员 WebView 的独立分区：继承既有的权限 fail-closed 策略，
 * 又不与内置浏览器共享会话；auth 与站点 Cookie 分域，不会互相顶登录。
 */
export function NibiAuthWebviewDialog({
  authorizeUrl,
  onCancel,
}: {
  authorizeUrl: string;
  onCancel: () => void;
}) {
  const platform = usePlatform();
  const { intl } = useNibiIntl();
  const webviewRef = useRef<ElectronWebviewTag | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const completedRef = useRef(false);
  const [loading, setLoading] = useState(true);

  const complete = useCallback(
    (url: string) => {
      if (completedRef.current) return;
      if (!url.startsWith(OAUTH_CALLBACK_PREFIX)) return;
      completedRef.current = true;
      setLoading(false);
      if (!platform.completeOAuthFromWebview) {
        // Web 端没有内嵌 WebView；桌面端未注入时不应静默卡住。
        return;
      }
      platform.completeOAuthFromWebview(url);
    },
    [platform],
  );

  const attachWebview = useCallback(
    (node: ElectronWebviewTag | null) => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      webviewRef.current = node;
      if (!node) return;

      const handleReady = () => setLoading(false);
      const handleStart = () => setLoading(true);
      const handleNavigate = (event: ElectronWebviewNavigationEvent) => {
        if (!event.url.startsWith(OAUTH_CALLBACK_PREFIX)) return;
        event.preventDefault();
        complete(event.url);
      };
      const handleFail = (event: ElectronWebviewDidFailLoadEvent) => {
        if (event.isMainFrame === false) return;
        if (event.validatedURL?.startsWith(OAUTH_CALLBACK_PREFIX)) {
          complete(event.validatedURL);
          return;
        }
        // -3 = ERR_ABORTED：正常跳转/取消中断，不当作登录失败。
        if (event.errorCode !== -3) setLoading(false);
      };

      node.addEventListener("dom-ready", handleReady);
      node.addEventListener("did-start-loading", handleStart);
      node.addEventListener("will-navigate", handleNavigate);
      node.addEventListener("will-redirect", handleNavigate);
      node.addEventListener("did-fail-load", handleFail);
      cleanupRef.current = () => {
        node.removeEventListener("dom-ready", handleReady);
        node.removeEventListener("did-start-loading", handleStart);
        node.removeEventListener("will-navigate", handleNavigate);
        node.removeEventListener("will-redirect", handleNavigate);
        node.removeEventListener("did-fail-load", handleFail);
      };
    },
    [complete],
  );

  useEffect(
    () => () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      // 关闭/成功后清掉 ticket，下一次登录重新取。
      platform.setAuthWebviewTicket?.("");
    },
    [platform],
  );

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      data-testid="nibi-auth-webview-dialog"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={intl.formatMessage({ id: "login.title" })}
        className="flex h-[min(760px,90vh)] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
      >
        <header className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-ui-lg font-semibold text-foreground">
              {intl.formatMessage({ id: "login.title" })}
            </h2>
            <p className="text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "login.oauth.waiting" }, { provider: "NIBI" })}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-lg"
            aria-label={intl.formatMessage({ id: "login.oauth.cancel" })}
            onClick={onCancel}
          >
            <XIcon className="size-4" aria-hidden="true" />
          </Button>
        </header>

        <div className="relative min-h-0 flex-1 bg-background">
          {loading ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-background">
              <Loader2Icon className="size-5 animate-spin text-foreground-subtle" aria-hidden="true" />
            </div>
          ) : null}
          <webview
            key={authorizeUrl}
            ref={attachWebview}
            src={authorizeUrl}
            partition={NIBI_MEMBERSHIP_WEBVIEW_PARTITION}
            allowpopups={"" as unknown as boolean}
            className="h-full w-full bg-background"
            data-testid="nibi-auth-webview"
          />
        </div>
      </section>
    </div>,
    document.body,
  );
}
