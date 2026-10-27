import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const waitForDefaults = fileURLToPath(new URL("./vitest.wait-for-defaults.ts", import.meta.url));

export default defineConfig({
  test: {
    // Bugfix: 外部 zcode-cli 历史里同时存在 test/ 和 tests/ 目录；合入 apps 后需要同时保留两种约定，避免新增包测试被根 include 规则过滤掉。
    setupFiles: [waitForDefaults],
    include: [
      "test/**/*.test.ts",
      "tests/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "packages/*/tests/**/*.test.ts",
    ],
    // 与仓库根 vitest.config.ts 同口径（2026-10-14 补）：CLI 这一侧有大量会真拉
    // sqlite / 起子进程 / 起 Protocol server 的集成用例，默认 5s 超时与不限并发在
    // 全量跑时会被调度饥饿打穿 —— 表现为「单独跑全绿、全量跑偶发失败」这类最难查的
    // flaky（实测：mcp.test.ts / session-store.test.ts 单独 37+44 全过，全量跑会挂）。
    // 上限从 30s 抬到 60s：与仓库根 vitest.config.ts 同步（真 runner 上合法重活被 30s
    // 截断过两次；I/O 密集用例在 4 核 CI 上实测比本机慢 70~200 倍）。
    hookTimeout: 60_000,
    testTimeout: 120_000,
    maxWorkers: 2,
  },
});
