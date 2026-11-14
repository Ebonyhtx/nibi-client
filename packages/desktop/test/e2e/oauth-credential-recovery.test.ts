import { readFile } from "node:fs/promises";
import { NIBI_PROVIDER_ID } from "@nibi/shared";
import {
  TID_LOGIN_TRIGGER,
  TID_OAUTH_ERROR,
  TID_OAUTH_LOGIN_BUTTON,
  testId,
} from "@nibi/shared/test-ids";
import {
  clearAppData,
  clickTestIdByDom,
  getE2EAppDataPaths,
  waitForTestIdByDom,
} from "./helpers/desktop-app.js";

const NIBI_LOGIN_BUTTON_ID = testId(TID_OAUTH_LOGIN_BUTTON, NIBI_PROVIDER_ID);
const OAUTH_CREDENTIAL_KEYS = [
  "oauth:active_provider",
  `oauth:${NIBI_PROVIDER_ID}:access_token`,
  `oauth:${NIBI_PROVIDER_ID}:refresh_token`,
  `oauth:${NIBI_PROVIDER_ID}:user_info`,
  "nibi-jwttoken",
] as const;

describe("OAuth 凭据损坏恢复", () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
    await clearAppData();
  });

  it("冷启动遇到无法解密的 OAuth 凭据时仍展示登录渠道并清理损坏登录态", async () => {
    await ensureOAuthLoginPanelOpen();
    await waitForTestIdByDom(NIBI_LOGIN_BUTTON_ID, {
      timeout: 20000,
      timeoutMsg: "损坏 OAuth 凭据恢复后没有展示 NIBI 登录入口",
    });
    await expectNibiLoginButton();
    await expectNoOAuthErrorAlert();
    await waitForCorruptOAuthCredentialsCleanup();
    expect((await readCredentials())["bot:e2e:credential"]).toBe("e2e-independent-bot-token");
  });
});

async function expectNibiLoginButton() {
  const buttonText = (await browser.execute((selectorId) => {
    return (
      document.querySelector<HTMLElement>(`[data-testid="${selectorId}"]`)?.textContent?.trim() ??
      ""
    );
  }, NIBI_LOGIN_BUTTON_ID)) as string;

  expect(buttonText).toContain("NIBI");
}

async function expectNoOAuthErrorAlert() {
  const errorText = (await browser.execute((selectorId) => {
    return (
      document.querySelector<HTMLElement>(`[data-testid="${selectorId}"]`)?.textContent?.trim() ??
      null
    );
  }, TID_OAUTH_ERROR)) as string | null;

  expect(errorText).toBeNull();
}

async function waitForCorruptOAuthCredentialsCleanup() {
  try {
    await browser.waitUntil(
      async () => {
        const credentials = await readCredentials();
        return OAUTH_CREDENTIAL_KEYS.every((key) => !(key in credentials));
      },
      {
        timeout: 10000,
        timeoutMsg: "损坏 OAuth 凭据没有被清理",
      },
    );
  } catch (error) {
    const credentials = await readCredentials().catch(() => null);
    const keys = credentials ? Object.keys(credentials).sort().join(", ") : "<missing>";
    throw new Error(`损坏 OAuth 凭据没有被清理，当前凭据 key: ${keys}`, {
      cause: error,
    });
  }
}

async function ensureOAuthLoginPanelOpen() {
  try {
    await browser.waitUntil(
      async () => {
        const state = await readLoginEntryState();
        return state.hasNibiLoginButton || state.hasLoginTrigger;
      },
      {
        timeout: 60000,
        timeoutMsg: "启动后没有出现 OAuth 登录面板或手动登录入口",
      },
    );
  } catch (error) {
    throw new Error(
      await buildLoginEntryTimeoutMessage("启动后没有出现 OAuth 登录面板或手动登录入口"),
      {
        cause: error,
      },
    );
  }

  const state = await readLoginEntryState();
  if (state.hasNibiLoginButton) {
    return;
  }

  // Bugfix: OAuth 凭据恢复 spec 只要求用户重新登录入口可用；当启动期已有可用
  // workspace shell 时，登录面板需要从 sidebar 手动打开，不能把“未自动弹 WelcomeScreen”
  // 误判为恢复失败。
  await clickTestIdByDom(TID_LOGIN_TRIGGER, {
    timeout: 20000,
    timeoutMsg: "损坏 OAuth 凭据恢复后没有可点击的手动登录入口",
  });
}

async function readLoginEntryState(): Promise<{
  hasLoginTrigger: boolean;
  hasNibiLoginButton: boolean;
}> {
  return (await browser.execute(
    (loginTriggerId, nibiLoginButtonId) => {
      return {
        hasLoginTrigger: Boolean(document.querySelector(`[data-testid="${loginTriggerId}"]`)),
        hasNibiLoginButton: Boolean(
          document.querySelector(`[data-testid="${nibiLoginButtonId}"]`),
        ),
      };
    },
    TID_LOGIN_TRIGGER,
    NIBI_LOGIN_BUTTON_ID,
  )) as {
    hasLoginTrigger: boolean;
    hasNibiLoginButton: boolean;
  };
}

async function buildLoginEntryTimeoutMessage(prefix: string) {
  const snapshot = await readOAuthRecoveryDomSnapshot().catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  return `${prefix}: ${JSON.stringify(snapshot)}`;
}

async function readOAuthRecoveryDomSnapshot() {
  return browser.execute(() => {
    const testIds = Array.from(document.querySelectorAll<HTMLElement>("[data-testid]"))
      .map((element) => element.dataset.testid ?? "")
      .filter(Boolean)
      .slice(0, 40);
    return {
      testIds,
      title: document.title,
      text: document.body.textContent?.replace(/\s+/g, " ").trim().slice(0, 600) ?? "",
      url: window.location.href,
    };
  });
}

async function readCredentials(): Promise<Record<string, string>> {
  const { credentialsFile } = getE2EAppDataPaths();
  return JSON.parse(await readFile(credentialsFile, "utf-8")) as Record<string, string>;
}
