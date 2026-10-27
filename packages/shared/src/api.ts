export interface ApiRequestInit extends RequestInit {
  timeoutMs?: number;
  /**
   * 固定请求 URL，不参与 ZCode endpoint 改写。
   *
   * NIBI 自家的 license / handoff 端点必须钉在 `NIBI_API_BASE_URL`：通用改写会把
   * `api.nibistudio.top` 的请求换成当前 ZCode endpoint（例如 `zcode.z.ai`），既让功能 404，
   * 也会把 NIBI access token 发给上游。只给 NIBI 专属请求用。
   */
  skipEndpointRewrite?: boolean;
}

export interface ApiClient {
  request(input: string | URL, init?: ApiRequestInit): Promise<Response>;
}

export interface ApiErrorOptions {
  message: string;
  url: string;
  method?: string;
  status?: number;
  responseHeaders?: Record<string, string>;
  cause?: unknown;
}

export class ApiError extends Error {
  readonly url: string;
  readonly method: string;
  readonly status?: number;
  readonly responseHeaders?: Record<string, string>;

  constructor(options: ApiErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ApiError";
    this.url = options.url;
    this.method = (options.method ?? "GET").toUpperCase();
    this.status = options.status;
    this.responseHeaders = options.responseHeaders;
  }
}
