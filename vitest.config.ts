import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const processLifecycleTests = [
  "packages/services/test/processTreeTerminator.test.ts",
  "packages/services/test/zcodeAgentService.test.ts",
  "packages/services/test/zcodeAgentService.v4.test.ts",
  "packages/services/test/zcodeAgentProcessManager.test.ts",
  "packages/services/test/zcodeStdioTransport.test.ts",
];
const forkIsolatedTests = [
  ...processLifecycleTests,
  // 真实显示进程树和独立配置读者都在 5 秒内等待启动；并发调度延迟曾触发截止。
  // 放入串行组保留真实进程和原时限，避免把启动排队误判为资源隔离或读锁失败。
  "packages/desktop/test/r3RemoteProcess.test.ts",
  "packages/provider-node/test/personal-config-read-lock.test.ts",
  // 原生 fs.watch 集成在批量并发时曾等不到通知；串行验证真实接线，去重逻辑由受控事件单测覆盖。
  "packages/services/src/gen-ui/adapters/stateStorage.test.ts",
  // electron-builder 下载 NSIS 时把进程 stdio 传给子进程，不能使用 threads 的虚拟 stdio。
  "packages/desktop/test/windowsInstallerCompile.test.ts",
  "packages/desktop/test/cdnPreloadScript.test.ts",
  "packages/desktop/test/desktopRuntimeEnv.test.ts",
  "packages/desktop/test/e2eDesktopBuildCache.test.ts",
  "packages/desktop/test/e2eSummarySpecCoverage.test.ts",
  "packages/desktop/test/migrateStableFeedScript.test.ts",
  "packages/desktop/test/pluginE2EAdmissionScripts.test.ts",
  "packages/desktop/test/uploadOssScript.test.ts",
  // 发布脚本会启动真实 Node/工具子进程，批量 threads 下曾打穿 30s；沿用发布类串行隔离。
  "packages/desktop/test/notarizeMacosScript.test.ts",
  "packages/desktop/test/publishReleaseScript.test.ts",
  // 选源集成测试连续启动 Git、Bash 和 Node；并发启动排队会打穿 30s，沿用发布类串行隔离。
  "packages/web/test/remoteFrontendBuildSource.test.ts",
  // Sharp 闭包装配后要启动真实 Node 加载原生库；并行热启动曾触发其 15s 子进程限时。
  "packages/desktop/test/dev-cua-plugin-runtime.test.ts",
  // 全量并发时真实心跳与嵌套构建会被调度延迟打穿；单独运行均通过，沿用串行组保留原时限。
  "packages/desktop/test/webRemoteControlTransport.test.ts",
  "packages/web/test/webRemoteControlTransport.test.ts",
  "packages/provider-node/test/builtin-provider-build.test.ts",
  "packages/provider-node/test/builtin-provider-test-config-sync.test.ts",
  "packages/server/test/remoteDeploy.test.ts",
  // Bugfix: 该集成测试会启动数百个真实 Git 子进程；放在普通 threads 并发组会让
  // macOS 进程启动队列饥饿，表现为 git init 长时间停在 dyld_start。
  "packages/services/test/gitService.test.ts",
  // Bugfix: checkpoint 集成测试同样会连续创建真实 Git 仓库；related 全量并发时会因
  // 子进程与磁盘调度饥饿超过 30 秒，隔离串行后保持聚焦运行时的真实耗时口径。
  "packages/services/test/gitCheckpointService.test.ts",
  "packages/services/test/mcpSyncService.test.ts",
  "packages/services/test/providerRuntimeResolver.test.ts",
  "packages/services/test/runtimeToolResolver.test.ts",
  // 该集成测试会真实启动 tsx、Supervisor 与多代 Core；放在普通 threads 中时，
  // 并行 worker 的进程启动压力会让 15 秒 ready barrier 偶发超时。
  "packages/zcode-server-cli/test/runtimeUpdateIntegration.test.ts",
  // Bugfix: pdfjs-dist legacy build 在 threads worker 内偶发原生崩溃（0xC0000005，
  // 测试自身通过、worker 收尾时崩，会把整场全量跑拦腰截断）。隔离到 fork 池后崩溃
  // 波及面收敛到本文件，其余测试结果可完整收集；崩溃根因见
  // docs/windows-test-compatibility.md。
  "packages/ui/test/pdfJsCMapSupport.test.ts",
];

/**
 * 只在 Windows 上有意义的测试：安装器/NSIS、PowerShell、进程树 taskkill/CIM、
 * Job Object、`.cmd` 产物、终端 shell 方言。
 *
 * 分界（2026-10-16 起）：CI 由两台自托管 runner 承担 —— VPS（Linux）跑"其余全部"，
 * 本机（Windows）跑这一批。所以这里只放**语义上就是 Windows** 的文件；跨平台但带
 * win32 分支的文件留在 unit/fork-isolated 里（在 Linux 上跑的是它的 POSIX 分支）。
 * 判断依据是"这个文件在 Linux 上还能不能验到它要验的东西"，不是"文件里出现过 .exe"。
 *
 * 3.16.2 基座重建时这段清单随上游 vitest.config.ts 一起丢了，CI 的
 * `--project windows-only` 因找不到项目直接启动失败；这里补回。
 */
const windowsOnlyTests = [
  "packages/desktop/test/windowsInstallerCompile.test.ts",
  "packages/desktop/test/windowsInstallerNshSmoke.test.ts",
  "packages/desktop/test/windowsInstallResourceLocks.test.ts",
  "packages/desktop/test/powershell-command.test.ts",
  "packages/desktop/test/e2eAllCoverageRunner.test.ts",
  // 进程树回收：Windows 分支走 taskkill + PowerShell/CIM 身份复核，Linux 走信号路径。
  // 这两个文件承载的是 Windows 那条路（含 8.3 短名、taskkill 失败码）的判据。
  "packages/services/test/processTreeTerminator.test.ts",
  "packages/services/test/processTreeTerminator.windows.test.ts",
  "packages/services/test/zcodeAgentProcessManager.test.ts",
  "packages/services/test/zcodeStdioTransport.test.ts",
  // 终端面板的 shell 方言矩阵含 PowerShell/pwsh 专属项。
  "packages/services/test/terminalService.test.ts",
  // 真 Electron 编译字节码：产物与运行时都按平台走，Linux 上 7 条用例全红（实测）。
  "packages/desktop/test/desktopAgentBytecode.test.ts",
  // 为 Windows 目标打包/安装：需要在 Windows 宿主上执行（stage/install 的 Windows 分支）。
  "packages/zcode-server-cli/test/packaging.test.ts",
  "packages/zcode-server-cli/test/releaseInstaller.test.ts",
];

/**
 * 已知在 **Linux 上挂起**、暂时不跑的用例（2026-10-16 首次在自托管 Linux runner 上跑全量时
 * 发现，两者在 Windows 上一直绿）：
 *
 * - `botsService.telegramPolling`：POSIX-only 用例（`it.runIf(platform !== "win32")`），
 *   第二个窗口等不到"Telegram long polling is handled by another NIBI window." 那个 idle
 *   状态，60s 超时。**这可能是真的跨平台缺陷**，需要单独排查。
 * - `desktopMainIpcRemoteTelemetry`：桌面 main 的 IPC 白名单用例在 Linux 上同样 60s 超时。
 *
 * 这是**欠账不是结论**：修好之后要把它们从这份名单里删掉（删掉即自动回到 unit 项目）。
 * 只在非 Windows 上排除，Windows 本机跑全量时它们照跑（telegram 那条在 Windows 上本来会 skip）。
 */
const linuxHangs = [
  "packages/services/test/botsService.telegramPolling.test.ts",
  "packages/desktop/test/desktopMainIpcRemoteTelemetry.test.ts",
];
const linuxOnlyExcludes = process.platform === "win32" ? [] : linuxHangs;

const waitForDefaults = fileURLToPath(new URL("./vitest.wait-for-defaults.ts", import.meta.url));

export default defineConfig({
  // 测试固定注入事件上报端点，使遥测上报链路在单测中可验证；真实构建由 scripts/build-time-config.mjs 决定。
  define: {
    __NIBI_TELEMETRY_REPORT_ENDPOINT__: JSON.stringify("https://zcode.z.ai/api/v1/event/report"),
  },
  resolve: {
    alias: {
      "@": resolve(__dirname, "packages/ui/src"),
      "@desktop": resolve(__dirname, "packages/desktop/src"),
      "@web": resolve(__dirname, "packages/web/src"),
      // 间接 import desktopNetworkTelemetry 等的单测无需真实 ARMS；需 vi.fn 的用例在文件内 vi.mock 覆盖
      // Bugfix: 具体的 /browser 子路径必须排在包根别名前，否则会被根别名拼成不存在的 stub.ts/browser。
      "@arms/rum-electron/browser": resolve(
        __dirname,
        "packages/desktop/test/mocks/armsRumElectronStub.ts",
      ),
      "@arms/rum-electron": resolve(
        __dirname,
        "packages/desktop/test/mocks/armsRumElectronStub.ts",
      ),
    },
  },
  test: {
    // wait-for-defaults 必须排在业务 setup 之前：它只包一层默认值，先装好才不会被
    // 后续 setup 里的用法绕开（两者都不依赖对方）。
    setupFiles: [waitForDefaults, "./vitest.setup.ts"],
    // 官方 affected 图不额外追踪 setupFiles；公共 setup 必须触发全量选择，再由入口跳过 UT 并成功退出。
    forceRerunTriggers: [
      ...configDefaults.forceRerunTriggers,
      // 默认配置 glob 的尾部 /** 在当前版本不能匹配部分配置文件，补充文件模式。
      "**/{vitest,vite}.config.*",
      "**/vitest.setup.ts",
    ],
    // 修复原因：全量 run 的 stdout 会把**通过**测试里的 console 输出一并转发——services 层
    // 用 createServiceLogger 的用例在绿态下也要刷几千行多行日志，全量输出因此膨胀到
    // ~3.3MB，超过 CI/工作流门禁对单条命令 256KB 的 stdout 上限，导致门禁整条命令被判
    // 「无法执行」而非测试失败。passed-only 只隐藏通过测试的 console，失败用例的日志与
    // 断言 diff 原样保留（诊断能力不降级）；全绿时输出收敛到 ~140KB。
    silent: "passed-only",
    // 修复原因：全量单测并发跑 Git、zip、Electron 模块导入时，默认 5s 超时在低配或高负载机器上
    // 容易被提前打穿（spawn git 子进程、模块 import 变慢 → flaky 超时）；中断后的文件句柄清理在
    // Windows 上还会触发 EPERM/ENOTEMPTY。此前只给 Windows 放宽，但 macOS/Linux 低配机同样会因
    // 内存抖动（swap thrashing）拖慢 spawn，故统一降低并发并放宽超时。
    hookTimeout: 30_000,
    maxWorkers: 4,
    testTimeout: 30_000,
    // 修复原因：900+ 文件全部使用隔离 fork 时，macOS 会在尾部因连续创建进程而随机
    // 启动 worker 超时。普通用例使用 threads；会修改 cwd/umask、回收 POSIX 进程树或
    // 密集 spawn shell 的用例最后串行 fork，避免跨用例误杀、进程级状态竞争和系统
    // spawn 队列饥饿。
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: [
            "packages/*/test/**/*.test.ts",
            // 架构治理要求 managed 模块自带 contract.test.ts（见 architecture-policy.yaml），放在模块目录内。
            "packages/*/src/**/contract.test.ts",
            // Gen UI 目录回归位于源码旁，默认入口也必须执行，避免只在手动定向运行时生效。
            "packages/shared/src/node/genUiPaths.test.ts",
            "packages/services/src/gen-ui/**/*.test.ts",
            "scripts/assert-safe-cua-helper-zip.test.mjs",
            "scripts/ci/ci-telemetry-keyword-guard.test.mjs",
          ],
          exclude: [
            "packages/desktop/test/e2e/**",
            "packages/zcode-cua/**",
            ...forkIsolatedTests,
            ...windowsOnlyTests,
            ...linuxOnlyExcludes,
          ],
          // Node 24/macOS 的 threads 全量运行可触发 V8 SIGSEGV；诊断时切换进程隔离，测试范围不变。
          pool: process.env.NIBI_TEST_POOL === "forks" ? "forks" : "threads",
          maxWorkers: process.env.NIBI_TEST_POOL === "forks" ? 2 : 4,
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "fork-isolated",
          include: forkIsolatedTests.filter((test) => !windowsOnlyTests.includes(test)),
          pool: "forks",
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          // 只由 Windows runner 跑（`vitest run --project windows-only`）。
          // Linux 侧用 `--project unit --project fork-isolated` 显式跳过。
          name: "windows-only",
          include: windowsOnlyTests,
          pool: "forks",
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { groupOrder: 2 },
        },
      },
      "packages/zcode-cua/vitest.config.ts",
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
    },
  },
});
