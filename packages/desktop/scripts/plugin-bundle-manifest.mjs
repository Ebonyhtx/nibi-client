/**
 * 随包内置的官方插件清单（打包链的数据源）。
 *
 * 为什么独立成文件：这张表是**内置口径的权威锚点**——插件仓库的内置目录与构建门禁
 * 都拿它机械对照（门禁会报"核对 N 个内置名"），防止名单过时或内置件被漏列/错列。
 * 它是纯声明式数据，搬出来既让主脚本回到可读长度，也让"改了哪条、加没加件"一目了然。
 *
 * 字段语义：
 *   packageName        npm 包名。注意**插件对外名以包内 .nibi-plugin/plugin.json 为准**，
 *                      两者可以不同（例：zcode-cua-plugin 的插件名是 computer-use）；
 *                      构建门禁按清单名推导，两者必须区分。
 *   relativePath       仓库内路径
 *   requiresRuntime    是否有需要构建的运行时（true 时会跑 runtimeBuildScript）
 *   requiredSeedPaths  随包必须存在的种子文件（少一个就打不出完整包，构建期报错）
 *   stagedPath         打进产物后的相对路径
 */
const browserUseRequiredRuntimePaths = [
  "scripts/browser-client.mjs",
  "docs/api.json",
  "docs/documents.json",
  "docs/overview.md",
  // documents.json 已暴露 recording lookup，桌面安装包不能复用缺少正文的 runtime。
  "docs/recording.md",
  "docs/workflow.md",
  "skills/control-browser/SKILL.md",
  "skills/web-gui-tester/SKILL.md",
];

const officialPluginPackages = [
  {
    packageName: "@nibi/visualize-plugin",
    relativePath: "apps/zcode-cli/packages/visualize-plugin",
    requiresRuntime: false,
    requiredSeedPaths: [
      "skills/visualize/SKILL.md",
      "skills/visualize/references/api.md",
      "skills/visualize/references/styles.md",
      "skills/visualize/tweak.md",
      "skills/visualize/LICENSE.md",
      "skills/visualize/scripts/render.py",
      "skills/visualize/assets/visualize.css",
      "skills/visualize/assets/visualize.html",
      "skills/visualize/assets/calendar.js",
      "skills/visualize/assets/runtime-manifest.json",
      "skills/visualize/scripts/vendor.py",
      "skills/visualize/assets/vendor/manifest.json",
      "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js",
      "skills/visualize/assets/vendor/floating-ui-core-1.7.3.min.js.LICENSE",
      "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js",
      "skills/visualize/assets/vendor/floating-ui-dom-1.7.4.min.js.LICENSE",
      "skills/visualize/assets/vendor/lucide-1.17.0.js",
      "skills/visualize/assets/vendor/lucide-1.17.0.js.LICENSE",
      "skills/visualize/assets/vendor/d3-7.9.0.min.js",
      "skills/visualize/assets/vendor/d3-7.9.0.min.js.LICENSE",
      "skills/visualize/widgets/calendar.md",
      "skills/visualize/examples/calendar.html",
      "skills/visualize/assets/standalone-host-bridge.js",
      "skills/visualize/assets/standalone-shell.js",
    ],
    requiredRuntimePaths: [],
    stagedPath: "packages/visualize-plugin",
  },
  {
    // browser-use 只携带自己的 client script 与 skill/docs；node_repl MCP runtime 归
    // @nibi/node-repl-host（见上方常量注释）。
    packageName: "@nibi/browser-use-plugin",
    relativePath: "apps/zcode-cli/packages/browser-use-plugin",
    requiresRuntime: true,
    requiredRuntimePaths: browserUseRequiredRuntimePaths,
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/browser-use-plugin",
  },
  {
    // node_repl 宿主：Browser Use 与 Computer Use 共用的 MCP runtime，本轮抽成独立包。
    // 它没有 listing（不进插件市场展示面），但生产包首启 seed 必须拿到它的 dist runtime，
    // 否则 bua/cua 任一开启时都会连不上 node_repl。
    packageName: "@nibi/node-repl-host",
    relativePath: "apps/zcode-cli/packages/node-repl-host",
    requiresRuntime: true,
    requiredRuntimePaths: ["dist/mcp/server.js"],
    runtimeBuildScript: "scripts/build.mjs",
    stagedPath: "packages/node-repl-host",
  },
  {
    // CUA 插件只携带 SDK/skill/docs；node_repl MCP runtime 归 @nibi/node-repl-host。
    packageName: "@nibi/cua-plugin",
    relativePath: "apps/zcode-cli/packages/zcode-cua-plugin",
    requiresRuntime: false,
    stagedPath: "packages/zcode-cua-plugin",
  },
  {
    // 文档四件套（内置，对齐上游）：纯内容 + Python 工具层，没有随包原生 runtime。
    // 完整种子清单在 bootstrap 的 OFFICIAL_*_REQUIRED_SEED_PATHS（那是运行时的判定）；
    // 这里只钉三个代表件（打包断言够用，也免得两处长清单各自漂移）。
    packageName: "@nibi/spreadsheets-plugin",
    relativePath: "apps/zcode-cli/packages/spreadsheets-plugin",
    requiresRuntime: false,
    // stagedPath 必须与 bootstrap 的 rootCandidates 对齐（apps 里叫 <name>-plugin）。
    // 漏了这个字段 resolve() 会收 undefined 直接抛 ERR_INVALID_ARG_TYPE —— 打包链实测踩过。
    stagedPath: "packages/spreadsheets-plugin",
    requiredSeedPaths: [
      "agents/visual-judge.md",
      "skills/xlsx/SKILL.md",
      "tools/nibi_kit/env.py",
    ],
  },
  {
    // 文档四件套（内置，对齐上游）：纯内容 + Python 工具层，没有随包原生 runtime。
    // 完整种子清单在 bootstrap 的 OFFICIAL_*_REQUIRED_SEED_PATHS（那是运行时的判定）；
    // 这里只钉三个代表件（打包断言够用，也免得两处长清单各自漂移）。
    packageName: "@nibi/documents-plugin",
    relativePath: "apps/zcode-cli/packages/documents-plugin",
    requiresRuntime: false,
    // stagedPath 必须与 bootstrap 的 rootCandidates 对齐（apps 里叫 <name>-plugin）。
    // 漏了这个字段 resolve() 会收 undefined 直接抛 ERR_INVALID_ARG_TYPE —— 打包链实测踩过。
    stagedPath: "packages/documents-plugin",
    requiredSeedPaths: [
      "agents/visual-judge.md",
      "skills/docx/SKILL.md",
      "tools/nibi_kit/env.py",
    ],
  },
  {
    // 文档四件套（内置，对齐上游）：纯内容 + Python 工具层，没有随包原生 runtime。
    // 完整种子清单在 bootstrap 的 OFFICIAL_*_REQUIRED_SEED_PATHS（那是运行时的判定）；
    // 这里只钉三个代表件（打包断言够用，也免得两处长清单各自漂移）。
    packageName: "@nibi/presentations-plugin",
    relativePath: "apps/zcode-cli/packages/presentations-plugin",
    requiresRuntime: false,
    // stagedPath 必须与 bootstrap 的 rootCandidates 对齐（apps 里叫 <name>-plugin）。
    // 漏了这个字段 resolve() 会收 undefined 直接抛 ERR_INVALID_ARG_TYPE —— 打包链实测踩过。
    stagedPath: "packages/presentations-plugin",
    requiredSeedPaths: [
      "agents/visual-judge.md",
      "skills/pptx/SKILL.md",
      "tools/nibi_kit/env.py",
    ],
  },
  {
    // 文档四件套（内置，对齐上游）：纯内容 + Python 工具层，没有随包原生 runtime。
    // 完整种子清单在 bootstrap 的 OFFICIAL_*_REQUIRED_SEED_PATHS（那是运行时的判定）；
    // 这里只钉三个代表件（打包断言够用，也免得两处长清单各自漂移）。
    packageName: "@nibi/pdf-plugin",
    relativePath: "apps/zcode-cli/packages/pdf-plugin",
    requiresRuntime: false,
    // stagedPath 必须与 bootstrap 的 rootCandidates 对齐（apps 里叫 <name>-plugin）。
    // 漏了这个字段 resolve() 会收 undefined 直接抛 ERR_INVALID_ARG_TYPE —— 打包链实测踩过。
    stagedPath: "packages/pdf-plugin",
    requiredSeedPaths: [
      "agents/visual-judge.md",
      "skills/pdf/SKILL.md",
      "tools/nibi_kit/env.py",
    ],
  },
  {
    // 上游随包内置、我们补齐的插件（内容与商店那份字节一致，见 sync-builtin-plugins.py）。
    packageName: "@nibi/android-emulator-plugin",
    relativePath: "apps/zcode-cli/packages/android-emulator-plugin",
    requiresRuntime: false,
    stagedPath: "packages/android-emulator-plugin",
    requiredSeedPaths: [".nibi-plugin/plugin.json", "skills/android-dev/SKILL.md", "dist/mcp/server.js", "hooks/hooks.json"],
  },
  {
    // 上游随包内置、我们补齐的插件（内容与商店那份字节一致，见 sync-builtin-plugins.py）。
    packageName: "@nibi/ios-simulator-plugin",
    relativePath: "apps/zcode-cli/packages/ios-simulator-plugin",
    requiresRuntime: false,
    stagedPath: "packages/ios-simulator-plugin",
    requiredSeedPaths: [".nibi-plugin/plugin.json", "skills/ios-dev/SKILL.md", "dist/mcp/server.js", "hooks/hooks.json"],
  },
  {
    // 上游随包内置、我们补齐的插件（内容与商店那份字节一致，见 sync-builtin-plugins.py）。
    packageName: "@nibi/restore-legacy-sessions-plugin",
    relativePath: "apps/zcode-cli/packages/restore-legacy-sessions-plugin",
    requiresRuntime: false,
    stagedPath: "packages/restore-legacy-sessions-plugin",
    requiredSeedPaths: [".nibi-plugin/plugin.json", "skills/restore-legacy-sessions/SKILL.md"],
  },
  {
    // 上游随包内置、我们补齐的插件（内容与商店那份字节一致，见 sync-builtin-plugins.py）。
    packageName: "@nibi/plugin-creator-plugin",
    relativePath: "apps/zcode-cli/packages/plugin-creator-plugin",
    requiresRuntime: false,
    stagedPath: "packages/plugin-creator-plugin",
    requiredSeedPaths: [".nibi-plugin/plugin.json", "skills/plugin-creator/SKILL.md"],
  },
  {
    // 上游随包内置、我们补齐的插件（内容与商店那份字节一致，见 sync-builtin-plugins.py）。
    packageName: "@nibi/skill-creator-plugin",
    relativePath: "apps/zcode-cli/packages/skill-creator-plugin",
    requiresRuntime: false,
    stagedPath: "packages/skill-creator-plugin",
    requiredSeedPaths: [".nibi-plugin/plugin.json", "skills/skill-creator/SKILL.md"],
  },
  {
    // 上游随包内置、我们补齐的插件（内容与商店那份字节一致，见 sync-builtin-plugins.py）。
    packageName: "@nibi/guide-plugin",
    relativePath: "apps/zcode-cli/packages/zcode-guide-plugin",
    requiresRuntime: false,
    stagedPath: "packages/zcode-guide-plugin",
    requiredSeedPaths: [".nibi-plugin/plugin.json", "skills/configuration-guide/SKILL.md"],
  },
  // superpowers 已从内置插件下线，改走 UI 推荐区按需安装；这里不再 stage 它的资源。
];


export { browserUseRequiredRuntimePaths, officialPluginPackages };

