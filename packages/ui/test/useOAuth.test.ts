import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BIGMODEL_PROVIDER_ID,
  CREDENTIAL_DECRYPT_ERROR_CODE,
  type OAuthProviderId,
  type OAuthProviderMeta,
} from "@nibi/shared";
import { useOAuth } from "@/hooks/useOAuth.js";

const mocks = vi.hoisted(() => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  oauthService: {
    cancelPending: vi.fn(async () => {}),
    getActiveProvider: vi.fn<() => Promise<OAuthProviderId | null>>(),
    getProviders: vi.fn<() => Promise<OAuthProviderMeta[]>>(),
    startOAuth: vi.fn(),
    startOAuthWithPolling: vi.fn(),
  },
  platform: {
    openExternal: vi.fn(),
    registerOAuthState: vi.fn(),
  },
  reportAppTelemetryEvent: vi.fn(async () => {}),
  setOAuthPollingActive: vi.fn(),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    oauthService: mocks.oauthService,
  }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => mocks.platform,
}));

vi.mock("@/store/StoreProvider.js", () => ({
  useNibiStore: (
    selector: (state: { setOAuthPollingActive: typeof mocks.setOAuthPollingActive }) => unknown,
  ) => selector({ setOAuthPollingActive: mocks.setOAuthPollingActive }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useNibiIntl: () => ({
    intl: {
      formatMessage: (descriptor: { id: string }) => descriptor.id,
    },
    locale: "zh-CN",
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: mocks.logger,
}));

vi.mock("@/lib/appTelemetry.js", () => ({
  reportAppTelemetryEvent: mocks.reportAppTelemetryEvent,
}));

interface OAuthProbeState {
  activeProvider: OAuthProviderId | null;
  authorizeUrl: string | null;
  loadingProviders: boolean;
  providers: OAuthProviderMeta[];
}

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const windowMock = {
    addEventListener: () => {},
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock as unknown as Document);
}

function OAuthProbe({ onState }: { onState: (state: OAuthProbeState) => void }) {
  const oauth = useOAuth();
  onState({
    activeProvider: oauth.activeProvider,
    authorizeUrl: oauth.authorizeUrl,
    loadingProviders: oauth.loadingProviders,
    providers: oauth.providers,
  });
  return createElement("span");
}

describe("useOAuth", () => {
  beforeEach(() => {
    mocks.logger.error.mockClear();
    mocks.logger.info.mockClear();
    mocks.logger.warn.mockClear();
    mocks.oauthService.cancelPending.mockClear();
    mocks.oauthService.getActiveProvider.mockReset();
    mocks.oauthService.getProviders.mockReset();
    mocks.oauthService.startOAuth.mockReset();
    mocks.oauthService.startOAuthWithPolling.mockReset();
    mocks.platform.openExternal.mockClear();
    mocks.platform.registerOAuthState.mockClear();
    mocks.reportAppTelemetryEvent.mockClear();
    mocks.setOAuthPollingActive.mockClear();
  });

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("keeps provider list visible when active provider credential cannot be decrypted", async () => {
    const provider: OAuthProviderMeta = {
      id: BIGMODEL_PROVIDER_ID,
      displayName: "BigModel",
      enabled: true,
      order: 0,
    };
    const observed: OAuthProbeState[] = [];
    const root: Root = createRoot(installMinimalDom());
    const decryptError = {
      code: CREDENTIAL_DECRYPT_ERROR_CODE,
      message: "Serialized credential decrypt failure",
    };

    mocks.oauthService.getProviders.mockResolvedValue([provider]);
    mocks.oauthService.getActiveProvider.mockRejectedValue(decryptError);

    await act(async () => {
      root.render(createElement(OAuthProbe, { onState: (state) => observed.push(state) }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(observed.at(-1)).toEqual({
      activeProvider: null,
      authorizeUrl: null,
      loadingProviders: false,
      providers: [provider],
    });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      "[useOAuth] 加载 active provider 凭据失败，已按未登录处理:",
      decryptError,
    );

    act(() => {
      root.unmount();
    });
  });

  it("does not hide non-credential active provider failures as logged-out state", async () => {
    const provider: OAuthProviderMeta = {
      id: BIGMODEL_PROVIDER_ID,
      displayName: "BigModel",
      enabled: true,
      order: 0,
    };
    const observed: OAuthProbeState[] = [];
    const root: Root = createRoot(installMinimalDom());
    const rpcError = new Error("RPC channel unavailable");

    mocks.oauthService.getProviders.mockResolvedValue([provider]);
    mocks.oauthService.getActiveProvider.mockRejectedValue(rpcError);

    await act(async () => {
      root.render(createElement(OAuthProbe, { onState: (state) => observed.push(state) }));
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(observed.at(-1)).toEqual({
      activeProvider: null,
      authorizeUrl: null,
      loadingProviders: false,
      providers: [],
    });
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(mocks.logger.error).toHaveBeenCalledWith("[useOAuth] 加载 provider 列表失败:", rpcError);

    act(() => {
      root.unmount();
    });
  });

  it("exposes the current authorize url and clears it when the waiting flow is cancelled", async () => {
    const root: Root = createRoot(installMinimalDom());
    let oauth: ReturnType<typeof useOAuth> | undefined;
    function OAuthActionProbe() {
      oauth = useOAuth();
      return createElement("span");
    }
    const authorizeUrl =
      "https://chat.z.ai/api/oauth/authorize?state=copy-state&client_id=nibi-client";
    mocks.oauthService.getProviders.mockResolvedValue([]);
    mocks.oauthService.getActiveProvider.mockResolvedValue(null);
    mocks.oauthService.startOAuthWithPolling.mockResolvedValue({
      authorizeUrl,
      provider: "zai",
      state: "copy-state",
    });

    await act(async () => {
      root.render(createElement(OAuthActionProbe));
    });
    await act(async () => {
      await oauth?.startLogin("zai");
    });

    // 等待态手动复制必须拿到完整授权地址，自动打开浏览器的行为保持不变。
    expect(oauth?.authorizeUrl).toBe(authorizeUrl);
    expect(mocks.platform.openExternal).toHaveBeenCalledWith(authorizeUrl);

    await act(async () => {
      await oauth?.cancel("zai");
    });

    // 取消后不能留下上一次登录的链接。
    expect(oauth?.authorizeUrl).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("clears the authorize url once login succeeds", async () => {
    const root: Root = createRoot(installMinimalDom());
    let oauth: ReturnType<typeof useOAuth> | undefined;
    function OAuthActionProbe() {
      oauth = useOAuth();
      return createElement("span");
    }
    const authorizeUrl = "https://chat.z.ai/api/oauth/authorize?state=success-state";
    mocks.oauthService.getProviders.mockResolvedValue([]);
    mocks.oauthService.getActiveProvider.mockResolvedValue(null);
    mocks.oauthService.startOAuthWithPolling.mockResolvedValue({
      authorizeUrl,
      provider: "zai",
      state: "success-state",
    });

    await act(async () => {
      root.render(createElement(OAuthActionProbe));
    });
    await act(async () => {
      await oauth?.startLogin("zai");
    });
    expect(oauth?.authorizeUrl).toBe(authorizeUrl);

    await act(async () => {
      await oauth?.setOAuthSuccess();
    });

    // 登录成功后等待态关闭，授权链接不能在后续界面里残留。
    expect(oauth?.authorizeUrl).toBeNull();

    act(() => {
      root.unmount();
    });
  });

  it("does not start Root polling for a custom deep-link provider", async () => {
    const root: Root = createRoot(installMinimalDom());
    let startLogin: ReturnType<typeof useOAuth>["startLogin"] | undefined;
    function OAuthActionProbe() {
      startLogin = useOAuth().startLogin;
      return createElement("span");
    }
    const customProvider = "custom-oauth" as OAuthProviderId;
    mocks.oauthService.getProviders.mockResolvedValue([]);
    mocks.oauthService.getActiveProvider.mockResolvedValue(null);
    mocks.oauthService.startOAuthWithPolling.mockResolvedValue({
      authorizeUrl: "https://example.com/oauth?state=custom-state",
      provider: customProvider,
      state: "custom-state",
    });

    await act(async () => {
      root.render(createElement(OAuthActionProbe));
    });
    await act(async () => {
      await startLogin?.(customProvider);
    });

    expect(mocks.setOAuthPollingActive).toHaveBeenCalledWith(false);

    act(() => {
      root.unmount();
    });
  });
});
