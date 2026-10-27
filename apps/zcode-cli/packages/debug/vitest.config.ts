import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 与仓库根 vitest.config.ts 同口径（2026-10-14 补）：本包有会真起 Hono server、
    // 读写 sqlite、采样子进程资源的集成用例，默认 5s 超时在全量并发（turbo 4 路 × 每包
    // 4 worker）下会被调度饥饿打穿——实测单独跑 18/18 全绿，并发跑 api.test.ts 超时。
    // 上限从 30s 抬到 60s：与仓库根 vitest.config.ts 同步（真 runner 上合法重活被 30s
    // 截断过两次；I/O 密集用例在 4 核 CI 上实测比本机慢 70~200 倍）。
    hookTimeout: 60_000,
    maxWorkers: 2,
    testTimeout: 120_000,
  },
});
