import { NIBI_VERSION, type ZCodeEnv } from "@nibi/shared";

declare const __NIBI_REMOTE_CDN_RELEASE_ROOTS__: readonly string[] | undefined;

/**
 * 远端资源（SSH source server 的 release 包）下载源**只允许自有域名**。
 *
 * 这里刻意**不提供任何默认域名**：上游代码原本在这里写死了 `cdn.codegeex.cn` 与
 * `cdn-zcode.z.ai` 两个第三方 CDN，并在"构建期没注入 CDN_DOMAIN"时回落到它们——
 * 等于把用户的远端连接行为外发给上游。NIBI 分家后不能保留这条回落：
 * 没有配置就是**这个功能不可用**，返回空数组，由调用方给出可读诊断。
 *
 * 配置方式（任一）：
 *   - 构建期注入 `CDN_DOMAIN`（可逗号分隔多个，按顺序尝试）+ `OSS_PATH_PREFIX`
 *     → 编译成 `__NIBI_REMOTE_CDN_RELEASE_ROOTS__`
 *   - 运行期 `NIBI_REMOTE_ASSET_CDN_BASE_URL` 覆盖（本地联调/灰度用）
 *
 * 见 docs/deployment/client-endpoint-and-distribution-standard.md §5。
 */
const TEST_REMOTE_CDN_RELEASE_ROOT = "http://intranet.example.invalid:12345/ssh-remote-assets";

export interface ResolveRemoteCdnOptions {
  env?: ZCodeEnv;
  locale?: string;
  timeZone?: string;
  overrideBaseUrl?: string;
  version?: string;
  now?: Date;
}

/**
 * 时区/语言偏好曾用来在「国内 CDN / 海外 CDN」两个默认源之间排序。
 * 两个默认源都是第三方域名，已按分家标准删除（见常量注释），
 * 因此这套偏好判断**失去了消费者**——保留它只会让下一个人以为还有双源可选。
 * 现在排序完全由构建期 `CDN_DOMAIN` 的顺序决定。
 */

export function resolveRemoteCdnBaseUrls(options: ResolveRemoteCdnOptions = {}): string[] {
  const overrideBaseUrl = options.overrideBaseUrl?.trim();
  if (overrideBaseUrl) {
    return [normalizeBaseUrl(overrideBaseUrl)];
  }

  const version = options.version ?? NIBI_VERSION;

  if (options.env === "test") {
    return [`${TEST_REMOTE_CDN_RELEASE_ROOT}/${version}`];
  }

  const configuredReleaseRoots =
    typeof __NIBI_REMOTE_CDN_RELEASE_ROOTS__ === "undefined"
      ? []
      : __NIBI_REMOTE_CDN_RELEASE_ROOTS__;
  if (configuredReleaseRoots.length > 0) {
    // remote runtime 的 manifest/components 下载根由构建期注入（CDN_DOMAIN/OSS_PATH_PREFIX），
    // 切换时只改 CI 变量，不碰源码。
    return configuredReleaseRoots.map(
      (releaseRoot) => `${normalizeBaseUrl(releaseRoot)}/${version}`,
    );
  }

  // 没有配置下载源 = 远端资源功能不可用。**不回落任何第三方域名**：
  // 返回空数组，调用方据此给出"未配置下载源"的可读诊断。
  return [];
}

export function resolvePrimaryRemoteCdnBaseUrl(
  options: ResolveRemoteCdnOptions = {},
): string | undefined {
  return resolveRemoteCdnBaseUrls(options)[0];
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}
