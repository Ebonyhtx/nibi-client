/**
 * 启动路径上的 /api/v1/client/configs 共享请求层。
 *
 * 强更 gate 与 Desktop 灰度 rollout 读同一个端点、同一份响应；此前各自发请求，
 * 冷启动时并存两个网络往返，且强更 gate 的等待会直接挡在主窗口创建前。
 *
 * 这里只做两件事：
 * - 同一时刻的并发消费复用同一个 in-flight 请求；
 * - 只缓存成功响应，且在 SHARED_CLIENT_CONFIGS_SUCCESS_CACHE_TTL_MS 内复用。
 *
 * 不缓存失败，也不缓存/复用任何解析后的灰度结论——每个消费者仍从原始 payload
 * 解析自己的字段（强更读 minimal_version，灰度读 data.configs.<key>），避免把
 * “灰度关闭”之类的结论错误当成强更配置。
 */

export const SHARED_CLIENT_CONFIGS_REQUEST_TIMEOUT_MS = 3_000;
export const SHARED_CLIENT_CONFIGS_SUCCESS_CACHE_TTL_MS = 30_000;

export interface CreateSharedClientConfigsFetcherOptions {
  /** 底层真实请求；signal 由共享层持有，消费者超时不会取消它。 */
  fetchConfig: (signal: AbortSignal) => Promise<unknown>;
  requestTimeoutMs?: number;
  cacheTtlMs?: number;
  now?: () => number;
}

export interface SharedClientConfigsFetcher {
  /**
   * 读取共享响应。没有 signal 参数是刻意的：灰度 rollout 的 abort 只结束它自己的等待，
   * 不能让同一次启动里的强更 gate 或另一个 rollout 失去正在进行的请求。
   */
  fetchConfig: () => Promise<unknown>;
}

export function createSharedClientConfigsFetcher(
  options: CreateSharedClientConfigsFetcherOptions,
): SharedClientConfigsFetcher {
  const requestTimeoutMs = Math.max(
    options.requestTimeoutMs ?? SHARED_CLIENT_CONFIGS_REQUEST_TIMEOUT_MS,
    1,
  );
  const cacheTtlMs = Math.max(options.cacheTtlMs ?? SHARED_CLIENT_CONFIGS_SUCCESS_CACHE_TTL_MS, 0);
  const now = options.now ?? Date.now;

  let cached: { payload: unknown; expiresAt: number } | undefined;
  let inFlight: Promise<unknown> | undefined;

  const startRequest = (): Promise<unknown> => {
    if (cached && now() < cached.expiresAt) {
      return Promise.resolve(cached.payload);
    }
    if (inFlight) {
      return inFlight;
    }

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const request = (async () => {
      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            // 先以明确的超时错误结束 race，再 abort 底层请求；否则底层 abort 的 rejection
            // 会抢在 timeoutPromise 前面成为最终错误，日志里看不出是超时。
            reject(new Error(`client configs request timed out after ${requestTimeoutMs}ms`));
            controller.abort();
          }, requestTimeoutMs);
          timeout.unref?.();
        });
        const payload = await Promise.race([
          options.fetchConfig(controller.signal),
          timeoutPromise,
        ]);
        cached = { payload, expiresAt: now() + cacheTtlMs };
        return payload;
      } finally {
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
        controller.abort();
      }
    })();

    inFlight = request;
    void request.then(
      () => {
        if (inFlight === request) {
          inFlight = undefined;
        }
      },
      () => {
        if (inFlight === request) {
          inFlight = undefined;
        }
      },
    );
    return request;
  };

  return { fetchConfig: startRequest };
}
