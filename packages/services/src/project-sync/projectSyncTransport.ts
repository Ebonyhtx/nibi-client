// 宿主侧的云端项目传输：登录令牌只在这里使用，插件/面板永远拿不到。
//
// 出口复用宿主统一的 apiClient（已接代理与会话身份），URL 固定到 NIBI API origin：
// 项目端点是 NIBI 自家服务，不能被通用 endpoint 改写，否则会把访问令牌发给别的域名。
import type { ApiClient } from "@nibi/shared";
import {
  ProjectSyncClient,
  type ProjectSyncTransport,
} from "./projectSyncClient.js";

export const NIBI_ACCESS_TOKEN_CREDENTIAL_KEY = "oauth:nibi:access_token";

export interface HostProjectSyncTransportOptions {
  apiClient: ApiClient;
  credentials: { load(key: string): Promise<string | null> };
  resolveEndpointOrigin: () => Promise<string> | string;
  timeoutMs?: number;
}

export function createHostProjectSyncTransport(
  options: HostProjectSyncTransportOptions,
): ProjectSyncTransport {
  const timeoutMs = options.timeoutMs ?? 60_000;

  async function authorization(): Promise<{ Authorization: string }> {
    const token = (await options.credentials.load(NIBI_ACCESS_TOKEN_CREDENTIAL_KEY))?.trim();
    if (!token) throw new Error("请先在 NIBI 客户端登录账号");
    return { Authorization: `Bearer ${token}` };
  }

  async function origin(): Promise<string> {
    return (await options.resolveEndpointOrigin()).replace(/\/+$/u, "");
  }

  return {
    async request(method, path, body) {
      const headers = await authorization();
      const response = await options.apiClient.request(`${await origin()}${path}`, {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        // 项目 API 在 NIBI 自家域；skipEndpointRewrite 防止把 access token 送到上游。
        skipEndpointRewrite: true,
        timeoutMs,
      });
      let parsed: unknown = {};
      try {
        parsed = await response.json();
      } catch {
        // 非 JSON 错误体按空体处理，状态码由调用方判定。
      }
      return { status: response.status, body: parsed };
    },

    async uploadObject(path, bytes, sha256) {
      const headers = await authorization();
      const response = await options.apiClient.request(`${await origin()}${path}`, {
        method: "PUT",
        headers: {
          ...headers,
          "Content-Type": "application/octet-stream",
          "X-Nibi-Object-Sha256": sha256,
        },
        body: bytes as unknown as RequestInit["body"],
        skipEndpointRewrite: true,
        timeoutMs,
      });
      let parsed: unknown = {};
      try {
        parsed = await response.json();
      } catch {
        // empty body on some proxies
      }
      return { status: response.status, body: parsed };
    },

    async downloadObject(path) {
      const headers = await authorization();
      const response = await options.apiClient.request(`${await origin()}${path}`, {
        method: "GET",
        headers,
        skipEndpointRewrite: true,
        timeoutMs,
      });
      if (response.status !== 200) {
        return { status: response.status, bytes: new Uint8Array() };
      }
      return { status: 200, bytes: new Uint8Array(await response.arrayBuffer()) };
    },
  };
}

export function createHostProjectSyncClient(
  options: HostProjectSyncTransportOptions,
): ProjectSyncClient {
  const serverUrl = "";
  return new ProjectSyncClient(createHostProjectSyncTransport(options), serverUrl);
}
