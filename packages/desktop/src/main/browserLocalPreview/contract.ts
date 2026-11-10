/**
 * browser-local-preview 对外契约：调用方只需要知道「如何解析 file: 导航」与「如何把
 * nibi-html 请求交给签名目录校验」。目录校验、签名密钥和 loader 细节都在实现内。
 *
 * 不变量：
 * - 签名密钥只存在于主进程内存；浏览分区重启后旧签名失效，恢复路径必须重新 resolve。
 * - respond 永远先验签与真实路径，再读文件；任何失败都不能回退到原始 file loader。
 */

export interface BrowserLocalPreviewPrivileges {
  scheme: string;
  privileges: Record<string, boolean>;
}

export type BrowserLocalPreviewFileFetcher = (
  fileUrl: string,
  method: "GET" | "HEAD",
) => Promise<Response>;

export interface BrowserLocalPreviewDependencies {
  realpath?: (path: string) => Promise<string>;
  isRegularFile?: (path: string) => Promise<boolean>;
  fetchFile?: BrowserLocalPreviewFileFetcher;
  randomBytes?: (size: number) => Uint8Array;
}

export interface BrowserLocalPreview {
  /**
   * file: 输入返回签名目录 URL；其它协议原样返回。
   * 前置：input 是绝对 URL；后置：返回 URL 的 root 已 realpath、文件在根内且为普通文件。
   * 失败即 reject，调用方必须 fail closed，不得回退加载原始 file。
   */
  resolveNavigation(input: string): Promise<string>;
  /**
   * 处理 nibi-html 请求：GET/HEAD 之外 405，验签/越界 403，目录或不存在 404。
   * 幂等：只读文件系统，不缓存响应（Cache-Control: no-store）。
   */
  respond(request: Request): Promise<Response>;
}

export interface BrowserLocalPreviewProtocolHost {
  protocol: {
    handle(
      scheme: string,
      handler: (request: Request) => Promise<Response> | Response,
    ): void;
  };
}
