import { vi } from "vitest";

/**
 * 把 `vi.waitFor` 的默认窗口从 1s 抬到 60s。
 *
 * 为什么需要：`vi.waitFor` 的默认 timeout 是硬编码的 1000ms（vitest 没有全局默认值的配置项），
 * 而它等的几乎都是**异步副作用**——事件落账、异步加锁写盘、子进程冷启动、watch 事件到达。
 * 在 4 核 CI runner 上这些比开发机慢一到两个数量级，于是"本机稳定通过"的用例在 CI 上偶发红，
 * 而且红在断言上、看不出是等待不够（实测已修过 `bash-direct-execution` 与
 * `nibi-builtin-lifecycle` 的 afterEach 两处，全仓还有数百处用的是这个默认值）。
 *
 * 改的是什么：只放宽"允许成功"的时间；断言本身一个字都没动，真失败仍会失败（晚 59 秒）。
 * 调用方显式传的 `timeout`（数字或对象）一律优先，不受影响。
 */
const WAIT_FOR_DEFAULTS = { interval: 50, timeout: 60_000 } as const;

const originalWaitFor = vi.waitFor.bind(vi);

vi.waitFor = ((callback: Parameters<typeof vi.waitFor>[0], options?: unknown) =>
  originalWaitFor(
    callback as never,
    typeof options === "number"
      ? { timeout: options }
      : { ...WAIT_FOR_DEFAULTS, ...((options ?? {}) as object) },
  ) as never) as typeof vi.waitFor;
