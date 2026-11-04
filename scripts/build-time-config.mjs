import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * 桌面构建期可选能力的唯一解析入口：ARMS RUM 上报、事件上报、自动更新。
 * 优先级：构建进程环境变量 > config/private/build-defaults.json（仅内部仓库存在）> 关闭。
 * 规则见 docs/desktop/build-time-optional-capabilities.md。
 */
export const PRIVATE_BUILD_DEFAULTS_PATH = resolve(
  import.meta.dirname,
  "../config/private/build-defaults.json",
);

const ENABLED_VALUES = new Set(["1", "true", "yes"]);

async function readPrivateDefaults(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`构建期私有默认配置必须是 JSON 对象：${path}`);
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function pickValue(env, defaults, key) {
  // 环境变量显式设置（包括空字符串）时优先，空字符串表示关闭该项能力
  if (typeof env[key] === "string") return env[key].trim();
  const value = defaults[key];
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 上报端点只允许「NIBI 自己的接收端」或空字符串（关闭）。
 * 上游域名必须在这里硬拒绝：一旦发出去，用户/设备数据就落到了我们不控制的服务。
 */
const UPSTREAM_HOST_MARKERS = ["zcode", "codegeex"];

function assertNibiOwnedEndpoint(key, value) {
  if (value === "") return value;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} 必须是绝对 URL，或留空关闭`);
  }
  const host = url.hostname.toLowerCase();
  const upstream =
    UPSTREAM_HOST_MARKERS.some((marker) => host.includes(marker)) ||
    host === "z.ai" ||
    host.endsWith(".z.ai");
  if (upstream) {
    throw new Error(
      `${key} 指向上游域名 ${host}；只能用 NIBI 自己的接收端，或留空关闭`,
    );
  }
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (url.protocol !== "https:" && !loopback) {
    throw new Error(`${key} 必须使用 https（本机回环可用 http）`);
  }
  return value;
}

export async function resolveBuildTimeConfig(
  env = process.env,
  { defaultsPath = PRIVATE_BUILD_DEFAULTS_PATH } = {},
) {
  const defaults = await readPrivateDefaults(defaultsPath);
  return {
    armsRumEndpoint: assertNibiOwnedEndpoint(
      "NIBI_ARMS_RUM_ENDPOINT",
      pickValue(env, defaults, "NIBI_ARMS_RUM_ENDPOINT"),
    ),
    telemetryReportEndpoint: assertNibiOwnedEndpoint(
      "NIBI_TELEMETRY_REPORT_ENDPOINT",
      pickValue(env, defaults, "NIBI_TELEMETRY_REPORT_ENDPOINT"),
    ),
    autoUpdateEnabled: ENABLED_VALUES.has(
      pickValue(env, defaults, "NIBI_AUTO_UPDATE").toLowerCase(),
    ),
  };
}

export function createBuildTimeConfigDefines(config) {
  return {
    __NIBI_ARMS_RUM_ENDPOINT__: JSON.stringify(config.armsRumEndpoint),
    __NIBI_TELEMETRY_REPORT_ENDPOINT__: JSON.stringify(config.telemetryReportEndpoint),
    __NIBI_AUTO_UPDATE_ENABLED__: JSON.stringify(config.autoUpdateEnabled),
  };
}
