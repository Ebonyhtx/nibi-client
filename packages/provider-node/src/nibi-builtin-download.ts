import {
  isNibiSignedContentUrl,
  nibiContentUrlCandidates,
  verifyNibiContentSignature,
} from "@nibi/shared/node";
import { z } from "zod";
import { decodeZCodeBuiltinRelease, type ZCodeBuiltinRelease } from "./nibi-builtin-release.js";

const clientConfigSchema = z
  .object({
    code: z.literal(0),
    data: z
      .object({
        configs: z
          .object({
            builtin_provider_config_json: z
              .string()
              .url()
              .refine((value) => {
                const url = new URL(value);
                return url.protocol === "https:" && !url.username && !url.password;
              })
              .optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export interface ZCodeBuiltinDownloadOptions {
  readonly endpointOrigin: string;
  readonly appVersion: string;
  readonly platform: string;
  readonly request: (url: string | URL, init: RequestInit) => Promise<Response>;
  readonly signal?: AbortSignal;
}

/** App/CLI 共用下载边界。总预算包含两次请求正文，不依赖 ApiClient 的响应头超时。 */
export async function downloadZCodeBuiltinRelease(
  options: ZCodeBuiltinDownloadOptions,
): Promise<ZCodeBuiltinRelease | null> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 20_000);
  timer.unref?.();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  let stage = "client-config";
  try {
    const url = new URL("/api/v1/client/configs", options.endpointOrigin);
    url.searchParams.set("app_version", options.appVersion);
    url.searchParams.set("platform", options.platform);
    const payload = clientConfigSchema.parse(await readJson(url));
    const downloadUrl = payload.data.configs.builtin_provider_config_json;
    if (downloadUrl === undefined) return null;
    stage = "cdn";
    // 交付面候选：主源（api/dl，德国为主）在前，国内镜像在后（兜底）。
    // 签名与正文必须来自同一候选（`.sig` 由该候选 URL 派生），否则会出现混搭。
    const candidates = nibiContentUrlCandidates(downloadUrl);
    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        const releaseUrl = new URL(candidate);
        // NIBI fork：我们的内容主机必须带 Ed25519 签名（`<file>.sig`，覆盖原始字节）；
        // 校验失败按拉取失败处理（保留上一份成功快照 + 退避重试），不引入半可信内容。
        const releaseBytes = await readBytes(releaseUrl);
        if (isNibiSignedContentUrl(releaseUrl.toString())) {
          stage = "signature";
          const signatureBytes = await readBytes(new URL(`${releaseUrl.toString()}.sig`));
          if (!verifyNibiContentSignature(releaseBytes, new TextDecoder().decode(signatureBytes))) {
            throw new DownloadBoundaryError("signature verification failed");
          }
        }
        return decodeZCodeBuiltinRelease(parseJsonBytes(releaseBytes));
      } catch (error) {
        lastError = error;
        stage = "cdn";
      }
    }
    throw lastError instanceof Error ? lastError : new DownloadBoundaryError("all candidates failed");
  } catch (error) {
    // 不能把带 query 的 URL、响应正文或 Schema 输入（可能含凭据）交给上层日志。
    const reason = signal.aborted
      ? timedOut
        ? "timeout"
        : "cancelled"
      : error instanceof DownloadBoundaryError
        ? error.message
        : error instanceof z.ZodError
          ? `invalid schema at ${error.issues[0]?.path.join(".") || "root"} (${error.issues[0]?.code})`
          : "invalid response";
    throw new Error(`ZCode Built-in ${stage}: ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  async function readJson(url: URL): Promise<unknown> {
    return parseJsonBytes(await readBytes(url));
  }

  function parseJsonBytes(bytes: Uint8Array): unknown {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  }

  async function readBytes(url: URL): Promise<Uint8Array> {
    signal.throwIfAborted();
    // 每次新建请求选项，不继承控制面鉴权；不跟随重定向把下载变成任意新来源。
    const response = await abortable(
      options
        .request(url, { method: "GET", signal, credentials: "omit", redirect: "error" })
        .then((value) => {
          if (signal.aborted) {
            void value.body?.cancel().catch(() => {});
            signal.throwIfAborted();
          }
          return value;
        }),
      signal,
    );
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw new DownloadBoundaryError(`HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new DownloadBoundaryError("empty body");
    const parts: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await abortable(reader.read(), signal);
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 10_000_000) throw new DownloadBoundaryError("body limit exceeded");
        parts.push(part.value);
      }
      signal.throwIfAborted();
      const merged = new Uint8Array(bytes);
      let offset = 0;
      for (const part of parts) {
        merged.set(part, offset);
        offset += part.byteLength;
      }
      return merged;
    } catch (error) {
      // cancel 不得成为新的无期限等待；释放 reader 后底层请求仍由同一 signal 取消。
      void reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
}

class DownloadBoundaryError extends Error {}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
