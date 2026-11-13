/**
 * NIBI 自有内容主机。
 *
 * 清单、插件 zip、图标、客户端配置与签名校验都只针对这几个 host；第三方市场与
 * 用户自加源永远不在白名单里。这里只保留 host 判定，不再包含任何备用源/镜像逻辑。
 */

export const NIBI_PRIMARY_CONTENT_HOSTS = new Set(["api.nibistudio.cn", "dl.nibistudio.cn"]);

export function isNibiPrimaryContentUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return NIBI_PRIMARY_CONTENT_HOSTS.has(url.hostname);
}
