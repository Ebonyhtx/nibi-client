import { Agent as HttpAgent, type ClientRequestArgs } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";
import { fetch as undiciFetch, ProxyAgent } from "undici";

/**
 * 中继出口的代理解析。
 *
 * 为什么单独一份：桌面主进程里，远控的 HTTP（设备注册 / 一次性 token）走 Node fetch，
 * WS 走 `ws` 直连；两者都不会自动读应用设置里的 `httpProxy`。宿主服务与 Chromium
 * 会话各自有代理配置，所以只修一处会出现“设置页配了代理，远控仍然连不上/绕过代理”。
 *
 * WS 的代理 Agent 是自己实现的 CONNECT 隧道：`https-proxy-agent` 及其依赖是 CJS，
 * 外部化会缺 `agent-base`，内联又会在 ESM main 里报 `Dynamic require of "net"`
 * （与 undici/node-forge 同一类问题，实测两轮）。这里只用 node:net/node:tls，
 * 不引入任何运行时依赖。
 */

export interface RelayProxySettings {
  httpProxy?: string | null;
  httpProxyMode?: "system" | "manual" | null;
  httpProxyNoProxy?: string | null;
}

// 代理规则只有一份：与分享产物下载等 Node 侧出口共用 shared/node/egressProxy。
// 这里保留旧导出名，避免既有调用点与测试改动。
export {
  normalizeEgressProxyUrl as normalizeRelayProxyUrl,
  matchesNoProxyRule,
  resolveEgressProxyForUrl as resolveRelayProxyForUrl,
} from "@nibi/shared/node";
import {
  resolveEgressProxyForUrl,
  resolveSystemProxyUrl,
  withEffectiveEgressProxy,
} from "@nibi/shared/node";

const httpDispatchers = new Map<string, ProxyAgent>();
const wsAgents = new Map<string, HttpAgent>();

/** HTTP 拉取：无代理时保持 Node 原生 fetch，行为与修复前完全一致。 */
export async function fetchWithRelayProxy(
  url: string | URL,
  init: RequestInit,
  proxyUrl: string | null,
): Promise<Response> {
  if (!proxyUrl) return fetch(url, init);
  let dispatcher = httpDispatchers.get(proxyUrl);
  if (!dispatcher) {
    dispatcher = new ProxyAgent(proxyUrl);
    httpDispatchers.set(proxyUrl, dispatcher);
  }
  const proxiedInit = { ...init, dispatcher } as unknown as Parameters<typeof undiciFetch>[1];
  return (await undiciFetch(url, proxiedInit)) as unknown as Response;
}

type ConnectOptions = ClientRequestArgs & { secureEndpoint?: boolean };
type ConnectCallback = (error: Error | null, stream: Duplex) => void;

function proxyAuthorization(proxy: URL): string | null {
  if (!proxy.username) return null;
  const username = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

/**
 * 打开一条 CONNECT 隧道；secure 时在隧道上再做目标 TLS（wss/https）。
 * 失败只回调一次，socket 一律销毁，避免 ws 重连时留下半开连接。
 */
function openTunnel(
  proxy: URL,
  timeoutMs: number,
  options: ConnectOptions,
  secure: boolean,
  done: ConnectCallback,
): undefined {
  const targetHost = String(options.hostname ?? options.host ?? "");
  const targetPort = Number(options.port ?? (secure ? 443 : 80));
  const proxyPort = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
  let settled = false;
  const proxySocket =
    proxy.protocol === "https:"
      ? tlsConnect({ host: proxy.hostname, port: proxyPort, servername: proxy.hostname })
      : netConnect({ host: proxy.hostname, port: proxyPort });

  const finish = (error: Error | null, stream?: Duplex) => {
    if (settled) return;
    settled = true;
    if (error) {
      proxySocket.destroy();
      done(error, null as unknown as Duplex);
      return;
    }
    done(null, stream as Duplex);
  };

  proxySocket.setTimeout(timeoutMs, () => finish(new Error("proxy connect timeout")));
  proxySocket.once("error", (error) => finish(error));

  const connectEvent = proxy.protocol === "https:" ? "secureConnect" : "connect";
  proxySocket.once(connectEvent, () => {
    const credentials = proxyAuthorization(proxy);
    const authority =
      targetHost.includes(":") ? `[${targetHost}]:${targetPort}` : `${targetHost}:${targetPort}`;
    proxySocket.write(
      `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n` +
        (credentials ? `Proxy-Authorization: ${credentials}\r\n` : "") +
        "\r\n",
    );

    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const headerEnd = buffered.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      proxySocket.off("data", onData);
      const statusLine =
        buffered.subarray(0, headerEnd).toString("latin1").split("\r\n")[0] ?? "";
      const rest = buffered.subarray(headerEnd + 4);
      if (rest.length > 0) proxySocket.unshift(rest);
      if (!/^HTTP\/1\.[01] 2\d\d\b/.test(statusLine)) {
        finish(new Error(`proxy CONNECT rejected: ${statusLine.slice(0, 80)}`));
        return;
      }
      proxySocket.setTimeout(0);
      if (!secure) {
        finish(null, proxySocket);
        return;
      }
      const tlsSocket = tlsConnect(
        { socket: proxySocket, servername: targetHost.replace(/^\[|\]$/g, "") },
        () => finish(null, tlsSocket),
      );
      tlsSocket.once("error", (error) => {
        tlsSocket.destroy();
        finish(error);
      });
    };
    proxySocket.on("data", onData);
  });
  return undefined;
}

class ConnectProxyHttpsAgent extends HttpsAgent {
  constructor(
    private readonly proxy: URL,
    private readonly tunnelTimeoutMs: number,
  ) {
    super({ keepAlive: false });
  }

  override createConnection(
    options: ClientRequestArgs,
    callback?: ConnectCallback,
  ): undefined {
    const done = callback ?? (() => {});
    return openTunnel(this.proxy, this.tunnelTimeoutMs, options as ConnectOptions, true, done);
  }
}

class ConnectProxyHttpAgent extends HttpAgent {
  constructor(
    private readonly proxy: URL,
    private readonly tunnelTimeoutMs: number,
  ) {
    super({ keepAlive: false });
  }

  override createConnection(
    options: ClientRequestArgs,
    callback?: ConnectCallback,
  ): undefined {
    const done = callback ?? (() => {});
    return openTunnel(this.proxy, this.tunnelTimeoutMs, options as ConnectOptions, false, done);
  }
}

/**
 * WS 建连用的 Agent；无代理时返回 undefined，让 `ws` 走默认直连。
 * wss 必须用 https.Agent（协议校验），ws 用 http.Agent；两者共用同一套 CONNECT 逻辑。
 */
export function createRelayProxyAgent(
  proxyUrl: string | null,
  targetProtocol: string = "wss:",
): HttpAgent | undefined {
  if (!proxyUrl) return undefined;
  const secure = targetProtocol === "wss:" || targetProtocol === "https:";
  const cacheKey = `${secure ? "https" : "http"}|${proxyUrl}`;
  let agent = wsAgents.get(cacheKey);
  if (!agent) {
    const proxy = new URL(proxyUrl);
    agent = secure
      ? new ConnectProxyHttpsAgent(proxy, 15_000)
      : new ConnectProxyHttpAgent(proxy, 15_000);
    wsAgents.set(cacheKey, agent);
  }
  return agent;
}

export type RelayProxySettingsLoader = () => Promise<RelayProxySettings | null | undefined>;

export function createRelayProxyResolver(
  loadSettings: RelayProxySettingsLoader,
): (url: string | URL) => Promise<string | null> {
  return async (url) => {
    try {
      const settings = await loadSettings();
      // system 用系统代理；manual 只用手填地址（空即直连）。回环/镜像隐式直连。
      const effective = withEffectiveEgressProxy(settings, await resolveSystemProxyUrl());
      return resolveEgressProxyForUrl(url, effective);
    } catch {
      // 设置读取失败按未配置代理处理：不能因为代理配置读不到就把远控彻底打死。
      return null;
    }
  };
}

export function __resetRelayProxyCacheForTests(): void {
  httpDispatchers.clear();
  wsAgents.clear();
}
