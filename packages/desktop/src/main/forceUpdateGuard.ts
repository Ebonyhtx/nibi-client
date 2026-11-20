import {
  DEFAULT_NIBI_ENDPOINT_ORIGIN,
  NIBI_VERSION,
  buildNibiEndpointUrls,
  getForceUpdateMinimalVersionFromConfig,
  resolveForceUpdateRequirement,
  type ForceUpdateRequirement,
  type Locale,
} from "@nibi/shared";
import {
  installReadyUpdate,
  requestForceAutoUpdate,
  type ForceAutoUpdateState,
} from "./autoUpdater.js";
import { readForceUpdateLkg, resolveForceUpdateRequirementFromLkg, writeForceUpdateLkg } from "./forceUpdateLkg.js";
import { showForceUpdatePrompt } from "./forceUpdatePrompt.js";

const NIBI_CLIENT_CONFIG_API_PATH = "/api/v1/client/configs";
/**
 * 强更 gate 在创建主窗口前执行；超时/失败按既有 fail-open 继续启动。
 * 2s 足够覆盖正常网络往返，又不让弱网把首屏拖到 10s。
 */
export const FORCE_UPDATE_CONFIG_REQUEST_TIMEOUT_MS = 2_000;
const FORCE_UPDATE_CONFIG_MAX_RESPONSE_BYTES = 1024 * 1024;

export interface ForceUpdateDialogText {
  title: string;
  message: string;
  detail: string;
  autoUpdateButton: string;
  manualUpdateButton: string;
  quitButton: string;
}

export interface ForceUpdateGuardLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface ForceUpdateGuardResult {
  blocked: boolean;
  requirement?: ForceUpdateRequirement;
}

export interface ForceUpdateGuardOptions {
  locale: Locale;
  logger: ForceUpdateGuardLogger;
  endpointOrigin?: string;
  fetchRemoteConfig?: () => Promise<unknown>;
  /** userData 目录；用于强更裁决的磁盘 LKG。 */
  lkgDirectory?: string;
  requestAutoUpdate?: (onStateChange?: (state: ForceAutoUpdateState) => void) => (() => void) | void;
  /** 只有用户在强更提示窗口点击“立即重启安装”后才调用。 */
  installUpdate?: () => void | Promise<void>;
  /** 安装前查询运行中任务数，用于提示“完成任务后再安装”。 */
  getRunningTaskCount?: () => number | Promise<number>;
  onBlocked?: (requirement: ForceUpdateRequirement) => void;
}

export function resolveForceUpdateClientConfigUrl(
  endpointOrigin = DEFAULT_NIBI_ENDPOINT_ORIGIN,
): string {
  const url = new URL(
    `${buildNibiEndpointUrls(endpointOrigin).origin}${NIBI_CLIENT_CONFIG_API_PATH}`,
  );
  url.searchParams.set("app_version", NIBI_VERSION);
  url.searchParams.set("platform", `${process.platform}-${process.arch}`);
  return url.toString();
}

function getForceUpdateMinimalVersionFromClientConfig(config: unknown): string | undefined {
  if (typeof config !== "object" || config === null) {
    return undefined;
  }

  const envelope = config as {
    code?: unknown;
    data?: {
      configs?: unknown;
    };
  };
  if (typeof envelope.code === "number" && envelope.code !== 0) {
    // /client/configs 与服务层一样只有 code=0 才可信，避免错误 envelope 携带旧 data 时误触发启动强更。
    throw new Error(`NIBI client config failed: ${envelope.code}`);
  }
  return getForceUpdateMinimalVersionFromConfig(envelope.data?.configs);
}

/**
 * 只限制启动 gate 自己的等待，不取消底层共享请求：
 * 注入的 fetcher 可能同时服务灰度 rollout，超时后让它在后台完成并写入短缓存，
 * 强更 gate 则按既有 fail-open 语义继续启动。
 */
function withForceUpdateRequestTimeout<T>(promise: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("force update config request timeout"));
    }, FORCE_UPDATE_CONFIG_REQUEST_TIMEOUT_MS);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function fetchRemoteForceUpdateConfig(
  endpointOrigin?: string,
  fetchRemoteConfig?: () => Promise<unknown>,
): Promise<unknown> {
  if (fetchRemoteConfig) {
    // 同步 throw 也统一转成 rejection，交给 resolveDesktopForceUpdateRequirement 的 fail-open。
    return withForceUpdateRequestTimeout(Promise.resolve().then(fetchRemoteConfig));
  }

  const { net } = await import("electron");
  return new Promise<unknown>((resolve, reject) => {
    let request: ReturnType<typeof net.request>;
    let timer: ReturnType<typeof setTimeout>;
    let data = "";
    let receivedBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      request?.abort();
      reject(error);
    };

    const finish = (value: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    timer = setTimeout(() => {
      fail(new Error("force update config request timeout"));
    }, FORCE_UPDATE_CONFIG_REQUEST_TIMEOUT_MS);
    timer.unref?.();

    request = net.request(resolveForceUpdateClientConfigUrl(endpointOrigin));
    request.on("response", (response) => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode < 200 || statusCode >= 300) {
        // 启动前强更 gate 不能把 4xx/5xx/HTML 错页当正常配置解析，统一走离线降级路径。
        fail(new Error(`force update config request failed with status ${statusCode}`));
        return;
      }

      response.on("data", (chunk) => {
        receivedBytes += Buffer.byteLength(chunk);
        if (receivedBytes > FORCE_UPDATE_CONFIG_MAX_RESPONSE_BYTES) {
          // 远端配置在主窗口创建前读取，必须限制响应体，避免异常响应撑爆 main 进程内存。
          fail(new Error("force update config response too large"));
          return;
        }
        data += chunk.toString();
      });
      response.on("end", () => {
        try {
          finish(JSON.parse(data));
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      response.on("error", (error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
    request.on("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
    request.end();
  });
}

export async function resolveDesktopForceUpdateRequirement(options: {
  logger: ForceUpdateGuardLogger;
  endpointOrigin?: string;
  fetchRemoteConfig?: () => Promise<unknown>;
  /** userData 目录；提供时成功裁决会写 LKG，网络失败后按新鲜 LKG 降级。 */
  lkgDirectory?: string;
  now?: () => number;
}): Promise<ForceUpdateRequirement | null> {
  const now = options.now ?? Date.now;
  const resolveFromMinimalVersion = (minimalVersion: string) =>
    resolveForceUpdateRequirement({
      currentVersion: NIBI_VERSION,
      forceUpdate: { minimalVersion },
    });

  try {
    const remoteConfig = await fetchRemoteForceUpdateConfig(
      options.endpointOrigin,
      options.fetchRemoteConfig,
    );
    const minimalVersion =
      getForceUpdateMinimalVersionFromClientConfig(remoteConfig) ??
      getForceUpdateMinimalVersionFromConfig(remoteConfig) ??
      "";
    if (options.lkgDirectory) {
      // 只在成功解析后写；错误 envelope / 超大响应 / 超时都不会污染 LKG。
      await writeForceUpdateLkg(options.lkgDirectory, minimalVersion || null, now());
    }
    return resolveFromMinimalVersion(minimalVersion) ?? null;
  } catch (error) {
    // 网络失败/超时时用最近一次成功裁决兜底；LKG 过期或不存在才保持原有 fail-open。
    const lkg = options.lkgDirectory
      ? await readForceUpdateLkg(options.lkgDirectory, now())
      : null;
    const fallback = resolveForceUpdateRequirementFromLkg({
      currentVersion: NIBI_VERSION,
      lkg,
    });
    if (fallback) {
      options.logger.warn("[force-update] 远端配置读取失败，按 last-known-good 执行强更裁决", {
        error,
        fetchedAt: lkg?.fetchedAt,
        minimalVersion: lkg?.minimalVersion,
      });
      return fallback;
    }
    // 没有可用 LKG 时保持原有离线跳过语义。
    options.logger.warn("[force-update] 读取远端强制升级配置失败，跳过强制升级校验", { error });
    return null;
  }
}

export function resolveForceUpdateDownloadUrl(
  locale: Locale,
  endpointOrigin = DEFAULT_NIBI_ENDPOINT_ORIGIN,
): string {
  const origin = buildNibiEndpointUrls(endpointOrigin).origin;
  return locale === "zh-CN" ? `${origin}/cn` : `${origin}/en`;
}

export function formatForceUpdateDialogText(
  requirement: ForceUpdateRequirement,
  locale: Locale,
): ForceUpdateDialogText {
  if (locale === "zh-CN") {
    return {
      title: "需要升级 NIBI",
      message: "当前版本无法继续使用",
      detail: `当前版本：v${requirement.currentVersion}\n最低可用版本：v${requirement.minimalVersion}`,
      autoUpdateButton: "立即更新",
      manualUpdateButton: "手动升级",
      quitButton: "退出",
    };
  }

  return {
    title: "Update NIBI",
    message: "The current version can no longer be used",
    detail: `Current version: v${requirement.currentVersion}\nMinimum supported version: v${requirement.minimalVersion}`,
    autoUpdateButton: "Update now",
    manualUpdateButton: "Manual update",
    quitButton: "Quit",
  };
}

export async function maybeBlockStartupForForceUpdate(
  options: ForceUpdateGuardOptions,
): Promise<ForceUpdateGuardResult> {
  const requirement = await resolveDesktopForceUpdateRequirement({
    ...options,
    endpointOrigin: options.endpointOrigin,
  });
  if (!requirement) {
    return { blocked: false };
  }

  options.logger.warn("[force-update] 远端配置要求强制升级，阻止创建主窗口", requirement);
  options.onBlocked?.(requirement);
  const { app, shell } = await import("electron");
  const action = await showForceUpdatePrompt(
    formatForceUpdateDialogText(requirement, options.locale),
    options.locale,
    options.logger,
    {
      startAutoUpdate: (onStateChange) =>
        options.requestAutoUpdate?.(onStateChange) ??
        requestForceAutoUpdate(onStateChange, "force-update", requirement.minimalVersion),
      // 强更提示同样只负责把用户送到 ready；“安装”必须由窗口里的显式点击触发。
      installUpdate: options.installUpdate ?? (() => installReadyUpdate()),
      getRunningTaskCount: options.getRunningTaskCount,
    },
  );
  if (action === "auto") {
    return { blocked: true, requirement };
  }

  if (action === "manual") {
    const url = resolveForceUpdateDownloadUrl(options.locale, options.endpointOrigin);
    options.logger.info(`[force-update] 用户选择手动升级：${url}`);
    await shell.openExternal(url);
  }

  // 强制升级命中后不能进入主界面；非自动升级路径处理完弹窗后退出，避免露出旧客户端功能。
  app.quit();
  return { blocked: true, requirement };
}
