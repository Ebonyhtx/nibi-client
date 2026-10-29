// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { OAuthProviderId } from "@nibi/shared";
import { WebRemoteControlDialog } from "@/web-remote-control/index.js";
import { LoginPanel } from "@/WelcomeScreen.js";

const state = vi.hoisted(() => ({
  user: { id: "cached-user", username: "User" } as { id: string; username: string } | null,
  theme: "nibi-dark",
  oauthError: null,
  oauthSuccessSeq: 0,
  lastOAuthSuccessProvider: null,
  loginEntryRequest: null as { id: number; providerId?: OAuthProviderId; purpose?: string } | null,
  requestLoginEntry: vi.fn(),
  clearLoginEntryRequest: vi.fn(),
  markLoginEntryAttemptStatus: vi.fn(),
  setOAuthError: vi.fn(),
}));
const oauth = vi.hoisted(() => ({
  startLogin: vi.fn(),
  cancel: vi.fn(),
  reset: vi.fn(),
  status: "idle",
  error: null,
  providers: [{ id: "zai", displayName: "Z.AI", enabled: true }],
  activeProvider: "zai" as OAuthProviderId | null,
  loadingProviders: false,
  pendingProvider: null,
  refreshProviders: vi.fn(),
}));
const toast = vi.hoisted(() => vi.fn());
const platform = vi.hoisted(() => ({
  getWebRemoteControlStatus: vi.fn(async () => ({ status: "auth-required" })),
}));
const intl = vi.hoisted(() => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }));

vi.mock("@/hooks/useOAuth.js", () => ({ useOAuth: () => oauth }));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (value: typeof state) => unknown) => selector(state),
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => platform }));
vi.mock("@/i18n/IntlProvider.js", () => ({ useZCodeIntl: () => intl }));
vi.mock("@/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) =>
    createElement("button", props, children),
}));
vi.mock("@/components/ui/dialog.js", () => {
  const Wrapper = ({ children }: { children?: ReactNode }) => createElement("div", null, children);
  return {
    Dialog: Wrapper,
    DialogContent: Wrapper,
    DialogDescription: Wrapper,
    DialogHeader: Wrapper,
    DialogTitle: Wrapper,
  };
});
vi.mock("@/components/ui/toast.js", () => ({ toast }));
vi.mock("@/BotsDialog.js", () => ({ BotsDialog: () => null }));
vi.mock("@/BotsDialog/shared.js", () => ({ ProviderIcon: () => null }));
vi.mock("@/components/ui/NibiAboutLogo.js", () => ({ NibiAboutLogo: () => null }));
vi.mock("@/login/LoginApiKeyForm.js", () => ({ LoginApiKeyForm: () => null }));
vi.mock("@/openWorkspacePageThemeHero.js", () => ({ ThemeHeroVisual: () => null }));
vi.mock("@/lib/oauthProviderIcon.js", () => ({ renderOAuthProviderIcon: () => null }));

function openDialog(onOpenChange = vi.fn()) {
  state.requestLoginEntry.mockImplementation((providerId?: OAuthProviderId, purpose?: string) => {
    state.loginEntryRequest = { id: 1, providerId, purpose };
  });
  return render(
    createElement(WebRemoteControlDialog, { open: true, onOpenChange, workspacePath: "/project" }),
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  state.user = { id: "cached-user", username: "User" };
  state.loginEntryRequest = null;
  oauth.activeProvider = "zai";
  oauth.loadingProviders = false;
});

it.each(["zai", "bigmodel", null] as const)(
  "远控401时始终重新发起 NIBI 账号登录（activeProvider=%s），不把缓存用户判为登录成功",
  async (providerId) => {
    oauth.activeProvider = providerId;
    const view = openDialog();
    fireEvent.click(await view.findByTestId("web-remote-control-login"));
    // 中继只认 NIBI token：即使用户缓存里还有其它渠道，也必须显式指定 NIBI，
    // 否则统一入口会把缓存用户当成已登录直接关页，远控仍然进不去。
    expect(state.requestLoginEntry).toHaveBeenCalledWith("nibi", "app-login");
    view.unmount();
    const onComplete = vi.fn();
    render(createElement(LoginPanel, { active: true, onComplete }));
    expect(oauth.startLogin).toHaveBeenCalledWith("nibi", { purpose: "app-login" });
    expect(onComplete).not.toHaveBeenCalled();
  },
);

it("provider仍在加载时不关闭弹窗或提交不完整登录请求", async () => {
  oauth.loadingProviders = true;
  const onOpenChange = vi.fn();
  const view = openDialog(onOpenChange);
  const button = await view.findByTestId("web-remote-control-login");
  expect(button.hasAttribute("disabled")).toBe(true);
  fireEvent.click(button);
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(state.requestLoginEntry).not.toHaveBeenCalled();
});

it("provider指针不可读时也直接发起 NIBI 登录，不再停在刷新失败的死路", async () => {
  oauth.activeProvider = null;
  const onOpenChange = vi.fn();
  const view = openDialog(onOpenChange);
  fireEvent.click(await view.findByTestId("web-remote-control-login"));
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(state.requestLoginEntry).toHaveBeenCalledWith("nibi", "app-login");
  expect(oauth.refreshProviders).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});

it("尚未登录且无active provider时同样进入 NIBI 登录，而不是空渠道选择页", async () => {
  state.user = null;
  oauth.activeProvider = null;
  const onOpenChange = vi.fn();
  const view = openDialog(onOpenChange);
  fireEvent.click(await view.findByTestId("web-remote-control-login"));
  expect(onOpenChange).toHaveBeenCalledWith(false);
  expect(state.requestLoginEntry).toHaveBeenCalledWith("nibi", "app-login");
  view.unmount();
  const onComplete = vi.fn();
  render(createElement(LoginPanel, { active: true, onComplete }));
  expect(oauth.startLogin).toHaveBeenCalledWith("nibi", { purpose: "app-login" });
  expect(onComplete).not.toHaveBeenCalled();
});
