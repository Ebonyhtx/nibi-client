/**
 * NIBI 付费凭证（license）的公开材料。
 *
 * 这里只放**公开**内容：验签公钥与签发方标识。私钥只在服务器上，永不入库。
 * 放在 shared 是因为两条独立进程都要用它——services 里的客户端判定层，
 * 以及 agent（apps/zcode-cli）里的收费插件安装门禁。
 */

/** 凭证签发方（compact JWS 的 iss）。 */
export const NIBI_LICENSE_ISSUER = "nibi-license";

/**
 * kid → SPKI PEM 公钥表。
 * 轮换流程：服务器换 key 后把新 kid/公钥追加到这里并重新发版；旧 kid 至少保留到
 * 所有未过期凭证都失效（最迟 7 天宽限 + 会员到期）。
 */
export const NIBI_LICENSE_PUBLIC_KEYS: Record<string, string> = {
  "z0SZbhR92-WZRiLD": `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA+QYJULcdmorIU9+SB9Fh6KOK2VGvuSo1dnPML0kxsCc=
-----END PUBLIC KEY-----
`,
};
