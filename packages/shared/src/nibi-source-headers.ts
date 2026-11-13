import { DEFAULT_NIBI_ENDPOINT_ORIGIN } from "./nibiEndpoint.js";

export const NIBI_SOURCE_HEADERS = {
  "User-Agent": "NIBI/unknown",
  "HTTP-Referer": DEFAULT_NIBI_ENDPOINT_ORIGIN,
  "X-Title": "NIBI@electron",
} as const;

export interface BuildNibiSourceHeadersFromContextOptions {
  appVersion?: string;
  arch?: string;
  clientLanguage?: string;
  clientTimezone?: string;
  deviceMid?: string;
  endpointOrigin?: string;
  osVersion?: string;
  platform?: string;
  releaseChannel?: string;
  sourceTitle?: string;
}

export function normalizeNibiSourceHeaderValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !/^[\x20-\x7e]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function buildNibiSourceHeadersFromContext(
  options: BuildNibiSourceHeadersFromContextOptions = {},
): Record<string, string> {
  const appVersion = normalizeNibiSourceHeaderValue(options.appVersion);
  const arch = normalizeNibiSourceHeaderValue(options.arch);
  const clientLanguage = normalizeNibiSourceHeaderValue(options.clientLanguage) ?? "unknown";
  const clientTimezone = normalizeNibiSourceHeaderValue(options.clientTimezone) ?? "unknown";
  const deviceMid = normalizeNibiSourceHeaderValue(options.deviceMid);
  const endpointOrigin =
    normalizeNibiSourceHeaderValue(options.endpointOrigin) ?? DEFAULT_NIBI_ENDPOINT_ORIGIN;
  const osVersion = normalizeNibiSourceHeaderValue(options.osVersion);
  const platform = normalizeNibiSourceHeaderValue(options.platform);
  const releaseChannel = normalizeNibiSourceHeaderValue(options.releaseChannel);
  const sourceTitle = normalizeNibiSourceHeaderValue(options.sourceTitle) ?? "electron";

  return {
    ...NIBI_SOURCE_HEADERS,
    "HTTP-Referer": endpointOrigin,
    "User-Agent": `NIBI/${appVersion ?? "unknown"}`,
    ...(appVersion ? { "X-NIBI-App-Version": appVersion } : {}),
    "X-Title": `NIBI@${sourceTitle}`,
    ...(platform && arch ? { "X-Platform": `${platform}-${arch}` } : {}),
    ...(releaseChannel ? { "X-Release-Channel": releaseChannel } : {}),
    "X-Client-Language": clientLanguage,
    "X-Client-Timezone": clientTimezone,
    ...(platform ? { "X-Os-Category": normalizeOsCategory(platform) } : {}),
    ...(osVersion ? { "X-Os-Version": osVersion } : {}),
    ...(deviceMid ? { "X-Device-Mid": deviceMid } : {}),
  };
}

function normalizeOsCategory(platform: string): string {
  switch (platform) {
    case "darwin":
      return "macos";
    case "win32":
      return "windows";
    default:
      return "linux";
  }
}
