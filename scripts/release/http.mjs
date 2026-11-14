#!/usr/bin/env node
// 发布校验共用的 HTTP 小工具：超时、有限重试、JSON 读取、对象探测与 sha256。
// 所有请求都允许注入 fetchImpl，单测不联网。

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_RETRIES = 2;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 带超时和有限重试的 fetch。404 等确定性状态不重试；5xx 与网络错误重试。
 * 测试可传 fetchImpl 与 retries: 0。
 */
export async function requestWithRetry(
  url,
  {
    fetchImpl = globalThis.fetch,
    method = "GET",
    headers = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    body,
  } = {},
) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method,
        headers: { "cache-control": "no-cache", ...headers },
        body,
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status >= 500 && attempt < retries) {
        lastError = new Error(`HTTP ${response.status}`);
        await sleep(250 * (attempt + 1));
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(250 * (attempt + 1));
    }
  }
  throw new Error(`请求失败：${url}：${errorMessage(lastError)}`);
}

export async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const contentType = response.headers.get("content-type") ?? "unknown";
    throw new Error(`响应不是 JSON（HTTP ${response.status}，${contentType}）`);
  }
}

function contentLength(headers) {
  const raw = headers.get("content-length");
  if (!raw) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

async function rangeProbe(url, options) {
  const response = await requestWithRetry(url, {
    ...options,
    method: "GET",
    headers: { range: "bytes=0-0", ...options.headers },
  });
  const range = response.headers.get("content-range");
  const total = range?.match(/\/(\d+)$/u)?.[1];
  return {
    status: response.status,
    ok: response.status === 200 || response.status === 206,
    size: total ? Number(total) : contentLength(response.headers),
  };
}

/**
 * 只探测对象是否存在/多大，默认 HEAD；服务端不支持 HEAD 时退化为 Range GET。
 * 401/403 也如实返回，调用方决定是否把它当作付费门禁。
 */
export async function probeUrl(url, options = {}) {
  try {
    const response = await requestWithRetry(url, { ...options, method: "HEAD" });
    if (response.status === 405 || response.status === 501) {
      return await rangeProbe(url, options);
    }
    return {
      status: response.status,
      ok: response.status === 200 || response.status === 206,
      size: contentLength(response.headers),
    };
  } catch (error) {
    return { status: 0, ok: false, size: null, error: errorMessage(error) };
  }
}

export async function downloadAndHash(url, options) {
  const response = await requestWithRetry(url, { ...options, method: "GET" });
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(bytes).digest("hex");
}
