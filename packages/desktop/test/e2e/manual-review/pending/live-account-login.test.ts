import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  TID_CONFIRM_DIALOG_CONFIRM,
  TID_LOGIN_MENU_ITEM,
  TID_LOGIN_TRIGGER,
  TID_LOGOUT_BUTTON,
  TID_OAUTH_LOGIN_BUTTON,
} from "@nibi/shared/test-ids";
import { getE2EAppDataPaths } from "../../helpers/desktop-app.js";
import { skipOccupationOnboardingIfPresent } from "../../helpers/occupation-onboarding.js";

/**
 * 真账号验收（manual-review，跑时带 `NIBI_E2E_LIVE_PRODUCTION=1`）：
 *
 * - `NIBI_E2E_LIVE_ACCOUNT=a`（默认）：会员账号 `test-m24-e2e-a` 走真实 NIBI OIDC 登录，
 *   断言身份/设备号，并等待 App 侧 license 同步落盘（`nibi:license:token` + `state`）；
 * - `NIBI_E2E_LIVE_ACCOUNT=b`：无会员对照 `test-m24-e2e-b`，断言身份切换为 guest 且没有 license；
 * - `NIBI_E2E_LIVE_SWITCH=1`：同一 App 会话里 A → 登出 → B → 登出 → A，验证账号切换。
 *
 * 登录不点浏览器：在主进程里把 `shell.openExternal` 换成记录器拿 authorize URL，交给服务端
 * `/opt/nibi-site/e2e-client-login.py` 无头完成密码登录，再把 `nibi://oauth/callback` 投回 App。
 * 密码只在服务器 0600 文件里，本地不打印。
 */
const NIBI_LOGIN_BUTTON = `${TID_OAUTH_LOGIN_BUTTON}-nibi`;
const USER_INFO_KEY = "oauth:nibi:user_info";
const LICENSE_TOKEN_KEY = "nibi:license:token";
const LICENSE_STATE_KEY = "nibi:license:state";
const DEVICE_KEY = "nibi:device:id";

type LiveAccount = "a" | "b";

const ACCOUNTS: Record<LiveAccount, { name: string }> = {
  a: { name: "E2E Member" },
  b: { name: "E2E Guest" },
};

// 注意：`browser.electron.execute` 只把函数体源码送到主进程，模块里的常量在那边不存在。
// 这些键必须在每个回调里写字面量，不能引用模块常量（否则回调抛 ReferenceError，
// execute 把异常吞成 undefined，表现成“探针什么都没记录”）。
interface MainProbeGlobals {
  __nibiE2EOpenedExternalUrls?: string[];
  __nibiE2EConsoleWarnings?: string[];
}

/**
 * 主进程探针：记录 `shell.openExternal` 的 URL 与 warn/error。
 *
 * 以前用 `browser.electron.mock`：mock 绑定在启动时的 WebDriver 会话上，登出后
 * renderer 重载/会话重建就失效，换账号时授权页再也“打不开”。直接改主进程里的
 * `shell.openExternal` 不依赖 WDIO mock 生命周期，重新执行一次即可覆盖。
 */
async function installMainProbe(): Promise<void> {
  await browser.electron.execute((electron) => {
    const globals = globalThis as unknown as MainProbeGlobals;
    globals.__nibiE2EOpenedExternalUrls ??= [];
    globals.__nibiE2EConsoleWarnings ??= [];
    if (!globals.__nibiE2EConsoleWarnings.length) {
      for (const level of ["warn", "error"] as const) {
        const original = console[level].bind(console);
        console[level] = (...args: unknown[]) => {
          globals.__nibiE2EConsoleWarnings!.push(
            `[${level}] ${args
              .map((value) =>
                typeof value === "string"
                  ? value
                  : value instanceof Error
                    ? `${value.name}: ${value.message}`
                    : JSON.stringify(value),
              )
              .join(" ")}`,
          );
          original(...args);
        };
      }
    }
    const shell = electron.shell as unknown as {
      openExternal: (url: string) => Promise<void> | void;
      __nibiE2EProbe?: boolean;
    };
    if (!shell.__nibiE2EProbe) {
      shell.__nibiE2EProbe = true;
      shell.openExternal = (url: string) => {
        globals.__nibiE2EOpenedExternalUrls!.push(String(url));
      };
    }
  });
}

async function openedExternalUrls(): Promise<string[]> {
  const urls = await browser.electron.execute(
    () => (globalThis as unknown as MainProbeGlobals).__nibiE2EOpenedExternalUrls ?? [],
  );
  return Array.isArray(urls) ? (urls as string[]) : [];
}

async function consoleWarnings(): Promise<string[]> {
  const lines = await browser.electron.execute(
    () => (globalThis as unknown as MainProbeGlobals).__nibiE2EConsoleWarnings ?? [],
  );
  return Array.isArray(lines) ? (lines as string[]) : [];
}

async function credentialKeys(): Promise<string[]> {
  try {
    const raw = await readFile(getE2EAppDataPaths().credentialsFile, "utf8");
    return Object.keys(JSON.parse(raw) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function readCredential(key: string): Promise<string | null> {
  try {
    const raw = await readFile(getE2EAppDataPaths().credentialsFile, "utf8");
    const value = (JSON.parse(raw) as Record<string, unknown>)[key];
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

async function waitForKey(key: string, present: boolean, timeout = 60_000): Promise<boolean> {
  try {
    await browser.waitUntil(
      async () => (await credentialKeys()).includes(key) === present,
      {
        timeout,
        interval: 1_000,
        timeoutMsg: `凭据 ${key} ${present ? "没有出现" : "没有被清除"}`,
      },
    );
    return true;
  } catch {
    return false;
  }
}

async function openLogin(): Promise<ChainablePromiseElement> {
  const button = await $(`[data-testid="${NIBI_LOGIN_BUTTON}"]`);
  const trigger = await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`);
  // 登出后页面先重载并异步拉取登录渠道：按钮可能晚几秒才渲染。
  // 以前直接 `isExisting()` 然后点侧栏触发器的写法会在登录页上点空。
  await browser.waitUntil(
    async () => (await button.isExisting()) || (await trigger.isExisting()),
    { timeout: 60_000, interval: 500, timeoutMsg: "登录入口没有出现" },
  );
  if (await button.isExisting()) return button;
  await trigger.click();
  const item = await $(`[data-testid="${TID_LOGIN_MENU_ITEM}"]`);
  try {
    await item.waitForClickable({ timeout: 10_000 });
    await item.click();
  } catch {
    // 登出后的渲染进程重载可能把这个菜单一起销毁；重载完成会直接落到登录页。
    if (await button.isExisting()) return button;
    throw new Error("侧栏登录菜单不可点，且登录页按钮没有出现");
  }
  await button.waitForClickable({ timeout: 60_000 });
  return button;
}

async function loginAs(account: LiveAccount): Promise<void> {
  await installMainProbe();
  await browser.electron.execute(() => {
    (globalThis as unknown as MainProbeGlobals).__nibiE2EOpenedExternalUrls = [];
  });
  const button = await openLogin();
  await button.click();
  let authorizeUrl: string | undefined;
  await browser.waitUntil(
    async () => {
      const urls = await openedExternalUrls();
      authorizeUrl = urls.find((url) => url.includes("/oauth/v2/authorize"));
      return authorizeUrl !== undefined;
    },
    { timeout: 30_000, timeoutMsg: "点击登录后没有打开授权页" },
  );
  expect(authorizeUrl).toContain("https://auth.nibistudio.top/oauth/v2/authorize");

  // 服务端无头登录（密码只在服务器的 0600 文件里）。URL 里的 & 必须原样带给远端 shell。
  // 连接参数走环境变量：E2E worker 的 HOME 是隔离目录，读不到 ~/.ssh/config；仓库里也不放地址/私钥路径。
  const sshTarget = process.env.NIBI_E2E_SSH_TARGET?.trim();
  const sshKey = process.env.NIBI_E2E_SSH_KEY?.trim();
  if (!sshTarget || !sshKey) {
    throw new Error(
      "真账号验收需要 NIBI_E2E_SSH_TARGET 与 NIBI_E2E_SSH_KEY（运行命令里给，不入库）",
    );
  }
  const quoted = `'${authorizeUrl!.replace(/'/gu, `'\\''`)}'`;
  const output = execFileSync(
    "ssh",
    [
      "-i",
      sshKey,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      sshTarget,
      `python3 /opt/nibi-site/e2e-client-login.py ${quoted} ${account}`,
    ],
    { encoding: "utf8", timeout: 180_000 },
  );
  const last = output.trim().split(/\r?\n/u).at(-1) ?? "";
  const callback = (JSON.parse(last) as { callback?: string }).callback;
  expect(callback).toContain("nibi://oauth/callback?");
  await browser.electron.execute(
    (electron, link) => {
      (
        electron.app as unknown as {
          emit: (name: string, event: unknown, url: string) => void;
        }
      ).emit("open-url", { preventDefault() {} }, link);
    },
    callback!,
  );
  const expectedName = ACCOUNTS[account].name;
  await browser.waitUntil(
    async () => (await browser.execute(() => document.body.innerText)).includes(expectedName),
    { timeout: 90_000, timeoutMsg: `登录后没有看到账号 ${expectedName}` },
  );
}

/** 登出（开发态会重载渲染进程，不走真实 relaunch）。 */
async function logout(): Promise<void> {
  // 开发态 RelaunchApp = webContents.reload()；必须等新文档起来再继续，
  // 否则下一次“点登录”会和重载赛跑：OAuth 请求先发、页面随后被刷新掉。
  const timeOriginBefore = await browser.execute(() => performance.timeOrigin);
  await $(`[data-testid="${TID_LOGIN_TRIGGER}"]`).click();
  await $(`[data-testid="${TID_LOGOUT_BUTTON}"]`).click();
  const confirm = await $(`[data-testid="${TID_CONFIRM_DIALOG_CONFIRM}"]`);
  await confirm.waitForDisplayed({ timeout: 15_000 });
  await confirm.click();
  expect(await waitForKey(USER_INFO_KEY, false, 30_000)).toBe(true);
  expect(await waitForKey(LICENSE_TOKEN_KEY, false, 30_000)).toBe(true);
  await browser.waitUntil(
    async () => (await browser.execute(() => performance.timeOrigin)) > timeOriginBefore,
    { timeout: 60_000, interval: 250, timeoutMsg: "登出后渲染进程没有重载" },
  );
  await skipOccupationOnboardingIfPresent();
}

async function dumpDiagnostics(label: string): Promise<void> {
  const env = (await browser.electron.execute(() => ({
    NIBI_ENV: process.env.NIBI_ENV,
    NIBI_BASE_URL: process.env.NIBI_BASE_URL,
    NIBI_ENDPOINT_ORIGIN: process.env.NIBI_ENDPOINT_ORIGIN,
    NIBI_PRODUCTION_BASE_URL: process.env.NIBI_PRODUCTION_BASE_URL,
    NIBI_TEST_BASE_URL: process.env.NIBI_TEST_BASE_URL,
  }))) as Record<string, string | undefined>;
  const settings = await readFile(
    join(getE2EAppDataPaths().homeDir, ".nibi", "v2", "setting.json"),
    "utf8",
  ).catch(() => "<missing>");
  let endpointOverride: unknown = "<missing>";
  try {
    endpointOverride = (JSON.parse(settings) as { zcodeEndpointOrigin?: unknown })
      .zcodeEndpointOrigin;
  } catch {
    // 设置文件不存在/还没落盘：保留原始文本标记，方便判断是“没读到”还是“没设置”。
  }
  const warnings = (await consoleWarnings()).filter(
    (line) => line.includes("nibiLicense") || line.includes("license"),
  );
  const keys = await credentialKeys();
  // 凭据落盘是 enc:v2 密文，测试进程没有安装密钥，只能看键与长度（不打印值）。
  console.log(
    `[live-account:${label}]`,
    JSON.stringify({
      env,
      settingsEndpointOverride: endpointOverride,
      credentialKeys: keys,
      licenseStateBytes: (await readCredential(LICENSE_STATE_KEY))?.length ?? 0,
      consoleWarnings: warnings,
    }),
  );
}

function selectedAccount(): LiveAccount {
  const raw = process.env.NIBI_E2E_LIVE_ACCOUNT?.trim().toLowerCase();
  return raw === "b" ? "b" : "a";
}

describe("live NIBI account (real server, manual)", () => {
  it("logs in through real NIBI OIDC and reports membership state", async function () {
    if (process.env.NIBI_E2E_LIVE_SWITCH === "1") this.skip();
    this.timeout(600_000);
    await skipOccupationOnboardingIfPresent();
    await installMainProbe();

    const account = selectedAccount();
    await loginAs(account);
    expect(await waitForKey(USER_INFO_KEY, true, 30_000)).toBe(true);
    expect(await waitForKey(DEVICE_KEY, true, 30_000)).toBe(true);

    // 身份由 UI 断言（loginAs 已等到账号名）；凭据是密文，这里只确认键已落盘。
    expect(await credentialKeys()).toContain(USER_INFO_KEY);

    // license 同步是登录后异步触发的；会员账号要等 token 落盘，guest 要等“没有 token”。
    const hasLicense = await waitForKey(LICENSE_TOKEN_KEY, true, 60_000);
    await dumpDiagnostics(account);
    if (account === "a") {
      // token 只在 200 authorized + license.token 的分支写入；键在 = 会员链走通。
      expect(hasLicense).toBe(true);
      expect(await credentialKeys()).toContain(LICENSE_STATE_KEY);
    } else {
      expect(hasLicense).toBe(false);
      // guest 也会写 state（服务端明确拒绝的快照）；state 在 = 请求真的到了服务端。
      expect(await credentialKeys()).toContain(LICENSE_STATE_KEY);
    }
  });

  it("switches accounts in one app session when NIBI_E2E_LIVE_SWITCH=1", async function () {
    if (process.env.NIBI_E2E_LIVE_SWITCH !== "1") this.skip();
    this.timeout(900_000);
    await skipOccupationOnboardingIfPresent();

    await loginAs("a");
    expect(await waitForKey(LICENSE_TOKEN_KEY, true, 60_000)).toBe(true);

    await logout();
    await loginAs("b");
    expect(await waitForKey(LICENSE_TOKEN_KEY, false, 30_000)).toBe(true);

    await logout();
    await loginAs("a");
    expect(await waitForKey(LICENSE_TOKEN_KEY, true, 60_000)).toBe(true);
  });
});
