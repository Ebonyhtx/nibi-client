import {
  WEB_REMOTE_CONTROL_RELAY_V2_HTTP,
  parseWebRemoteControlRelayV2HttpResponse,
  WebRemoteControlV2ConnectionError,
  type WebRemoteControlRelayV2HttpOperation,
  type WebRemoteControlRelayV2HttpRequest,
  type WebRemoteControlRelayV2HttpResponse,
} from "@nibi/shared/web-remote-relay";
import { fetchWithRelayProxy } from "#src/main/web-remote-relay/webRemoteControlProxy.js";

/** Main 直接 Node fetch；不使用会触发全局登出的 services HTTP 客户端。 */
export function createWebRemoteControlV2Http(
  endpointOrigin: string,
  fetcher = fetch,
  options: {
    /** 每次请求前解析代理；null/缺省 = 直连，保持修复前的调用路径。 */
    resolveProxyForUrl?: (url: string | URL) => Promise<string | null>;
    /** 失败诊断：只给 operation/是否走代理/错误码，不带 URL、token 或代理凭据。 */
    onRequestFailure?: (details: { operation: string; proxied: boolean; code: string }) => void;
  } = {},
) {
  async function request<K extends WebRemoteControlRelayV2HttpOperation>(
    operation: K,
    body: WebRemoteControlRelayV2HttpRequest<K>,
    jwt: string,
    signal: AbortSignal,
  ): Promise<WebRemoteControlRelayV2HttpResponse<K>> {
    const { method, path } = WEB_REMOTE_CONTROL_RELAY_V2_HTTP[operation];
    let proxied = false;
    try {
      const url = new URL(path, endpointOrigin);
      // 没有解析器时不能 await（哪怕 await undefined 也会让出一个微任务）：
      // 调用方可能在 request 返回后立刻 abort，时序变化会让已取消的请求继续挂起。
      const resolveProxy = options.resolveProxyForUrl;
      const proxyUrl = resolveProxy ? await resolveProxy(url) : null;
      proxied = Boolean(proxyUrl);
      const init: RequestInit = {
        method,
        headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
        body: method === "GET" ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        redirect: "error",
      };
      const response = proxyUrl
        ? await fetchWithRelayProxy(url, init, proxyUrl)
        : await fetcher(url, init);
      if (response.status === 401) throw new WebRemoteControlV2ConnectionError("auth-required");
      if (!response.ok)
        throw new WebRemoteControlV2ConnectionError("relay-unavailable", response.status >= 500);
      // 读取正文也可能断网或超时，必须交给外层网络重试；只有完整但非法的 JSON 才是终态。
      const responseBody = await response.text();
      let value: unknown;
      try {
        value = JSON.parse(responseBody);
      } catch {
        throw new WebRemoteControlV2ConnectionError("relay-unavailable");
      }
      const parsed = parseWebRemoteControlRelayV2HttpResponse(operation, value);
      if (!parsed || parsed.code !== 0)
        throw new WebRemoteControlV2ConnectionError("relay-unavailable");
      return parsed;
    } catch (error) {
      if (error instanceof WebRemoteControlV2ConnectionError) throw error;
      options.onRequestFailure?.({
        operation,
        proxied,
        code: extractNetworkErrorCode(error),
      });
      throw new WebRemoteControlV2ConnectionError("relay-unavailable", true);
    }
  }
  return {
    async register(deviceMid: string, jwt: string, signal: AbortSignal) {
      const result = await request("register", { device_mid: deviceMid }, jwt, signal);
      if (!result.data) throw new WebRemoteControlV2ConnectionError("relay-unavailable");
      return result.data.device_sid;
    },
    async token(jwt: string, signal: AbortSignal) {
      const result = await request("token", { role: "device" }, jwt, signal);
      if (!result.data) throw new WebRemoteControlV2ConnectionError("relay-unavailable");
      return result.data.token;
    },
    async delete(deviceSid: string, jwt: string, signal: AbortSignal) {
      await request("delete", { device_sid: deviceSid }, jwt, signal);
    },
  };
}

function extractNetworkErrorCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const code = cause?.code ?? (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.trim()) return code.trim();
  return error instanceof Error ? error.name : "unknown";
}
