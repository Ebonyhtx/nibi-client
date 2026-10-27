import type { ZCodeRuntimeEnv } from "./runtimeEnv.js";

export type ZCodeEnv = "test" | "production";
/** 安装包身份：决定应用名、app id、Electron 数据目录与更新策略；与后端环境 `ZCodeEnv` 是两个轴。 */
export type ZCodeProductFlavor = "production" | "preview";
export type ArmsRumEnv = "local" | "prod";

// 非构建环境（如 e2e 测试的 mocha）下 define 不存在，用 typeof 检查 + fallback 避免 ReferenceError
declare const __NIBI_ENV__: string;
declare const __NIBI_PRODUCT_FLAVOR__: string;
declare const __NIBI_ARMS_RUM_ENDPOINT__: string;
declare const __NIBI_TELEMETRY_REPORT_ENDPOINT__: string;
declare const __NIBI_AUTO_UPDATE_ENABLED__: boolean;

export function normalizeZCodeEnv(value: string | undefined): ZCodeEnv {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

export const NIBI_ENV = normalizeZCodeEnv(
  typeof __NIBI_ENV__ !== "undefined" ? __NIBI_ENV__ : undefined,
);

/**
 * 身份缺省跟随后端环境（test → preview，production → production）。
 * 桌面构建通过 `NIBI_PREVIEW_IDENTITY=1` 显式注入 preview，得到连接生产后端的 Preview 包；
 * 未注入 define 的 bundle（web、CLI、测试）沿用旧的单轴语义。
 */
export function normalizeZCodeProductFlavor(
  value: string | undefined,
  zcodeEnv: ZCodeEnv,
): ZCodeProductFlavor {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "production" || normalized === "preview") {
    return normalized;
  }
  return zcodeEnv === "production" ? "production" : "preview";
}

export const NIBI_PRODUCT_FLAVOR = normalizeZCodeProductFlavor(
  typeof __NIBI_PRODUCT_FLAVOR__ !== "undefined" ? __NIBI_PRODUCT_FLAVOR__ : undefined,
  NIBI_ENV,
);
export const NIBI_APP_VERSION_ENV = "NIBI_APP_VERSION" as const;
export const NIBI_BUILD_COMMIT_ID_ENV = "NIBI_BUILD_COMMIT_ID" as const;
/** 远端 workspace identity，spawn agent 时注入；只用于隔离/审计，不用于文件执行。 */
export const NIBI_WORKSPACE_IDENTITY_ENV = "NIBI_WORKSPACE_IDENTITY" as const;

// ── 运行时环境变量（不经过编译打包，启动时从 process.env 读取） ──
// 启用调试模式，值为 inspect-brk 的端口号，如 NIBI_DEBUG=9230
export const RUNTIME_NIBI_DEBUG =
  typeof process !== "undefined" ? process.env.NIBI_DEBUG : undefined;

// ── 构建期可选能力（见 docs/desktop/build-time-optional-capabilities.md），未注入时一律关闭 ──
/** ARMS RUM 上报地址；为空时 SDK 以 enable=false 初始化，不产生上报。 */
export const NIBI_ARMS_RUM_ENDPOINT: string =
  typeof __NIBI_ARMS_RUM_ENDPOINT__ !== "undefined" ? __NIBI_ARMS_RUM_ENDPOINT__ : "";
/** 事件上报（数仓）地址；为空时不上报。 */
export const NIBI_TELEMETRY_REPORT_ENDPOINT: string =
  typeof __NIBI_TELEMETRY_REPORT_ENDPOINT__ !== "undefined"
    ? __NIBI_TELEMETRY_REPORT_ENDPOINT__
    : "";
/** 桌面自动更新是否启用。 */
export const NIBI_AUTO_UPDATE_ENABLED: boolean =
  typeof __NIBI_AUTO_UPDATE_ENABLED__ !== "undefined" ? __NIBI_AUTO_UPDATE_ENABLED__ : false;

/** 将本地运行态与编译期 NIBI_ENV 映射为 ARMS 控制台识别的上报环境标签 */
export function mapZCodeEnvToArmsRumEnv(runtimeEnv: ZCodeRuntimeEnv): ArmsRumEnv {
  return runtimeEnv !== "development" && NIBI_ENV === "production" ? "prod" : "local";
}
