// @vitest-environment jsdom

/**
 * 登录等待态「复制登录链接」
 *
 * 背景：浏览器打不开、没有默认浏览器或被安全软件拦截时，OAuth 等待态只有「取消」，
 * 用户无法手动完成登录，只能改走 API key。这里验证拿到 authorizeUrl 后复制入口的
 * 出现条件、复制内容以及取消后的状态清理。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TID_OAUTH_CANCEL,
  TID_OAUTH_COPY_LINK,
  TID_OAUTH_LOGIN_BUTTON,
  testId,
} from "@nibi/shared/test-ids";

const oauthState = vi.hoisted(() => ({
  status: "waiting" as "idle" | "waiting" | "error",
  error: null as string | null,
  authorizeUrl: null as string | null,
  pendingProvider: "nibi" as string | null,
  providers: [{ id: "nibi", displayName: "NIBI", enabled: true, order: 0 }] as Array<{
    id: string;
    displayName: string;
    enabled: boolean;
    order: number;
  }>,
}));

const oauthActions = vi.hoisted(() => ({
  startLogin: vi.fn(),
  cancel: vi.fn(),
  reset: vi.fn(),
}));

const storeState = vi.hoisted(() => ({
  oauthError: null as string | null,
  setOAuthError: vi.fn(),
  markLoginEntryAttemptStatus: vi.fn(),
}));

const toastMock = vi.hoisted(() => vi.fn());

const authorizeUrl =
  "https://chat.z.ai/api/oauth/authorize?state=copy-state&client_id=nibi-client&redirect_uri=nibi%3A%2F%2Foauth";

// 登录壳新增窗控；夹具提供平台命令，继续聚焦 OAuth 等待态交互。
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ executeDesktopCommand: vi.fn().mockResolvedValue(undefined) }),
}));

vi.mock("@/hooks/useOAuth.js", () => ({
  useOAuth: () => ({
    startLogin: oauthActions.startLogin,
    cancel: oauthActions.cancel,
    reset: oauthActions.reset,
    status: oauthState.status,
    error: oauthState.error,
    authorizeUrl: oauthState.authorizeUrl,
    providers: oauthState.providers,
    activeProvider: null,
    loadingProviders: false,
    pendingProvider: oauthState.pendingProvider,
    refreshProviders: vi.fn(),
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useNibiIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useNibiStore: (selector: (state: unknown) => unknown) =>
    selector({
      user: null,
      oauthError: storeState.oauthError,
      setOAuthError: storeState.setOAuthError,
      oauthSuccessSeq: 0,
      lastOAuthSuccessProvider: null,
      loginEntryRequest: null,
      loginEntryAttempt: null,
      clearLoginEntryRequest: vi.fn(),
      markLoginEntryAttemptStatus: storeState.markLoginEntryAttemptStatus,
    }),
}));

vi.mock("@/components/ui/toast.js", () => ({
  toast: toastMock,
  updateToast: vi.fn(),
  dismissToast: vi.fn(),
}));

async function renderWelcomeScreen() {
  const { WelcomeScreen } = await import("@/WelcomeScreen.js");
  const view = render(createElement(WelcomeScreen, { onComplete: vi.fn() }));
  return { view, WelcomeScreen };
}

function installClipboard(writeText: ReturnType<typeof vi.fn>) {
  Object.defineProperty(globalThis.navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

describe("登录等待态复制登录链接", () => {
  beforeEach(() => {
    oauthState.status = "waiting";
    oauthState.error = null;
    oauthState.authorizeUrl = authorizeUrl;
    oauthState.pendingProvider = "nibi";
    oauthActions.startLogin.mockClear();
    oauthActions.cancel.mockClear();
    oauthActions.reset.mockClear();
    storeState.setOAuthError.mockClear();
    storeState.markLoginEntryAttemptStatus.mockClear();
    toastMock.mockClear();
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(globalThis.navigator, "clipboard");
  });

  it("拿到授权链接后在等待态展示复制按钮", async () => {
    await renderWelcomeScreen();

    expect(screen.getByTestId(TID_OAUTH_COPY_LINK)).toBeTruthy();
    expect(screen.getByText("login.oauth.copyLink")).toBeTruthy();
    expect(screen.getByTestId(TID_OAUTH_CANCEL)).toBeTruthy();
  });

  it("点击复制按钮把完整授权链接写入剪贴板并提示成功", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard(writeText);
    await renderWelcomeScreen();

    fireEvent.click(screen.getByTestId(TID_OAUTH_COPY_LINK));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(authorizeUrl));
    expect(toastMock).toHaveBeenCalledWith("login.oauth.copyLinkSucceeded");
  });

  it("剪贴板写入失败时提示失败", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("clipboard denied"));
    installClipboard(writeText);
    await renderWelcomeScreen();

    fireEvent.click(screen.getByTestId(TID_OAUTH_COPY_LINK));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(authorizeUrl));
    expect(toastMock).toHaveBeenCalledWith("login.oauth.copyLinkFailed");
  });

  it("尚未拿到授权链接时不展示复制按钮", async () => {
    oauthState.authorizeUrl = null;
    await renderWelcomeScreen();

    expect(screen.queryByTestId(TID_OAUTH_COPY_LINK)).toBeNull();
    // 等待态本身仍然保留取消入口。
    expect(screen.getByTestId(TID_OAUTH_CANCEL)).toBeTruthy();
  });

  it("取消回到渠道列表后不残留复制按钮", async () => {
    const { view, WelcomeScreen } = await renderWelcomeScreen();

    fireEvent.click(screen.getByTestId(TID_OAUTH_CANCEL));
    expect(oauthActions.cancel).toHaveBeenCalledWith("nibi");

    // 模拟 useOAuth.cancel 完成：状态回 idle、授权链接清空。
    oauthState.status = "idle";
    oauthState.authorizeUrl = null;
    oauthState.pendingProvider = null;
    view.rerender(createElement(WelcomeScreen, { onComplete: vi.fn() }));

    expect(screen.queryByTestId(TID_OAUTH_COPY_LINK)).toBeNull();
    expect(screen.queryByTestId(TID_OAUTH_CANCEL)).toBeNull();
    expect(screen.getByTestId(testId(TID_OAUTH_LOGIN_BUTTON, "nibi"))).toBeTruthy();
  });
});
