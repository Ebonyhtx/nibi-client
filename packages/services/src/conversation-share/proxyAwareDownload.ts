/**
 * 分享产物下载的出口：按应用设置里的 `httpProxy` 走代理，未配置则直连。
 *
 * 为什么需要它（2026-10-26 实测）：`ConversationShareService` 的默认下载实现是全局 `fetch`，
 * 它不读应用设置。主源被线路阻断、只有代理能出网的用户发布分享正常（上传走宿主自己的
 * 代理感知客户端），但**导入带产物的分享时按签名 URL 直连下载会 ECONNRESET**。
 *
 * 规则与中继共用 `shared/node/egressProxy`（未配置/命中 noProxy → 直连），保证
 * 「设置页配了代理」对所有 Node 侧出口语义一致。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import {
  resolveEgressProxyForUrl,
  resolveSystemProxyUrl,
  withEffectiveEgressProxy,
  type EgressProxySettings,
} from "@nibi/shared/node";

export interface ShareDownloadSettings extends EgressProxySettings {
  /** 用户自定义 CA（PEM 文件路径）；配置后代理隧道上的目标证书按它校验。 */
  httpProxyCaCertPath?: string | null;
}

type DownloadInit = { signal?: AbortSignal };
export type ShareDownload = (url: string, init?: DownloadInit) => Promise<Response>;

const MAX_PROXY_AGENTS = 8;
const MAX_CA_CACHE_ENTRIES = 32;
const agents = new Map<string, ProxyAgent>();
const caCache = new Map<string, { pem: string; hash: string }>();

function readCaPem(path: string | null | undefined): { pem: string; hash: string } | null {
  const trimmed = path?.trim();
  if (!trimmed) return null;
  const cached = caCache.get(trimmed);
  if (cached) {
    caCache.delete(trimmed);
    caCache.set(trimmed, cached);
    return cached;
  }
  try {
    const pem = readFileSync(trimmed, "utf8");
    const hash = createHash("sha256").update(pem).digest("hex").slice(0, 16);
    if (caCache.size >= MAX_CA_CACHE_ENTRIES) {
      const oldest = caCache.keys().next().value;
      if (oldest !== undefined) caCache.delete(oldest);
    }
    const entry = { pem, hash };
    caCache.set(trimmed, entry);
    return entry;
  } catch {
    // CA 读取失败不写入负缓存，避免文件暂不可读后永久锁死回退。
    return null;
  }
}

function agentFor(proxyUrl: string, ca: { pem: string; hash: string } | null): ProxyAgent {
  const key = `${proxyUrl}\u0000${ca ? `ca:${ca.hash}` : "system"}`;
  const existing = agents.get(key);
  if (existing) {
    agents.delete(key);
    agents.set(key, existing);
    return existing;
  }
  if (agents.size >= MAX_PROXY_AGENTS) {
    const oldest = agents.entries().next();
    if (!oldest.done) {
      agents.delete(oldest.value[0]);
      void oldest.value[1].close().catch(() => {});
    }
  }
  const agent = new ProxyAgent({
    uri: proxyUrl,
    ...(ca ? { connect: { ca: ca.pem } } : {}),
  });
  agents.set(key, agent);
  return agent;
}

/** 关闭并清空模块级分享下载代理连接池，供宿主退出回收。 */
export async function closeProxyDownloadAgents(): Promise<void> {
  const active = Array.from(agents.values());
  agents.clear();
  caCache.clear();
  await Promise.all(active.map((agent) => agent.close().catch(() => {})));
}

/**
 * 生成一个下载实现：每次调用现读设置（用户在设置页改代理后立刻生效，无需重启宿主）。
 * 无代理时保持原生 fetch，行为与修复前完全一致。
 */
export function createProxyAwareShareDownload(
  loadSettings: () => Promise<ShareDownloadSettings | null | undefined>,
): ShareDownload {
  return async (url, init) => {
    let settings: ShareDownloadSettings | null | undefined = null;
    try {
      settings = await loadSettings();
    } catch {
      settings = null;
    }
    // system 模式用探测到的系统代理；manual 模式只用手填地址，空即直连。
    // 镜像与回环由 egressProxy 隐式直连。
    const effective = withEffectiveEgressProxy(settings, await resolveSystemProxyUrl());
    const proxyUrl = resolveEgressProxyForUrl(url, effective);
    if (!proxyUrl) return fetch(url, { signal: init?.signal });
    const agent = agentFor(proxyUrl, readCaPem(settings?.httpProxyCaCertPath));
    const response = await undiciFetch(url, {
      signal: init?.signal,
      dispatcher: agent,
    });
    return response as unknown as Response;
  };
}
