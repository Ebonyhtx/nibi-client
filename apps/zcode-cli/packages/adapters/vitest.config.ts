import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const waitForDefaults = fileURLToPath(new URL("../../vitest.wait-for-defaults.ts", import.meta.url));

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "tests/**/*.test.ts"],
    // 宿主隔离：清掉继承来的代理变量，否则 `vi.stubGlobal("fetch")` 会被
    // NodeHttpClientAdapter 的代理分支绕过、真的打外网（详见该文件注释）。
    setupFiles: [waitForDefaults, "tests/setup-host-isolation.ts"],
    // 与仓库根 vitest.config.ts 同口径（2026-10-14 补）：本包有会真起子进程 /
    // 拉 sqlite / 起 MCP 与 OAuth 流程的集成用例，默认 5s 超时与不限并发在全量跑时
    // 会被调度饥饿打穿（实测 mcp.test.ts / session-store.test.ts 单独全绿、全量偶发失败）。
    // 上限从 30s 抬到 60s：与仓库根 vitest.config.ts 同步（真 runner 上合法重活被 30s
    // 截断过两次；I/O 密集用例在 4 核 CI 上实测比本机慢 70~200 倍）。
    hookTimeout: 60_000,
    maxWorkers: 2,
    testTimeout: 120_000,
    // 上游自带失败（2026-10-14 核实，**不是我们的回归**）：该文件与上游 v3.15.1 逐字节相同，
    // 且其 import 的 `../src/model/catalog.js` 在**上游任何 ref 里都不存在**（死 import，
    // 导致整个 suite 报错、里面 17 条断言此前从未被执行）。移除该死 import 后暴露出的断言
    // 差异同样是上游自己的（例：断言 JSON 不含 `options: {}`，而上游实现就会写入该键）。
    // 判据：`diff <(git show aac47556:apps/zcode-cli/packages/adapters/tests/config.test.ts) <file>` 仅含去品牌改名。
    exclude: ["tests/config.test.ts"],
  },
});
