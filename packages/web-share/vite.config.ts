import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolveRuntimeNibiEndpointOrigin } from "../shared/src/nibiEndpoint.js";

// Share 构建刻意不依赖 packages/web（见 docs/web-share/web-share-build-decoupling.md）。
// 发布标记很小，这里保留一份同样形状的实现，避免把完整 Web 的源码拖进 Share 构建上下文。
function releaseJsonPlugin({ surface, version, environment, commit }) {
  if (!surface || !version) throw new Error("releaseJsonPlugin requires surface and version");
  const resolvedCommit = commit || "unknown";
  return {
    name: "nibi-release-json",
    apply: "build",
    transformIndexHtml() {
      return [
        {
          tag: "meta",
          attrs: { name: "nibi-release-version", content: version },
          injectTo: "head",
        },
        {
          tag: "meta",
          attrs: { name: "nibi-release-surface", content: surface },
          injectTo: "head",
        },
        {
          tag: "meta",
          attrs: { name: "nibi-release-commit", content: resolvedCommit },
          injectTo: "head",
        },
      ];
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "release.json",
        source: `${JSON.stringify(
          {
            schemaVersion: 1,
            surface,
            version,
            environment,
            commit: resolvedCommit,
          },
          null,
          2,
        )}\n`,
      });
    },
  };
}

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const { version } = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8"));

export default defineConfig(({ command, mode }) => {
  const env = { ...loadEnv(mode, REPO_ROOT, ""), ...process.env };
  const nibiEnv = env.NIBI_ENV?.trim().toLowerCase() === "production" ? "production" : "test";
  // 发布档硬门禁：NIBI_ENV 不是 production 时，下面的 define 会把 VITE_NIBI_BASE_URL 烘焙成
  // 上游测试档，部署后整页请求打到上游、表现为 CORS 失败。
  // 2026-10-26 实际踩过一次，所以在构建入口直接拦下，而不是靠人记。
  if (
    command === "build" &&
    nibiEnv !== "production" &&
    env.NIBI_ALLOW_NON_PRODUCTION_BUILD !== "1"
  ) {
    throw new Error(
      "[web-share] build 必须 NIBI_ENV=production：否则 API 源会被烘焙成上游测试档。" +
        "确需测试档构建请显式设 NIBI_ALLOW_NON_PRODUCTION_BUILD=1。",
    );
  }
  const endpointEnv = { ...env, NIBI_ENV: nibiEnv };
  const endpointOrigin = resolveRuntimeNibiEndpointOrigin(endpointEnv);

  return {
    root: resolve(HERE),
    base: "/cn/share/",
    // Share 复用 Web 的 material-icons 素材，但不复制完整 Web 源码/依赖。
    // 这样 dev:web-share 与 Docker 生产构建都从同一份 public 资源读取图标。
    publicDir: resolve(REPO_ROOT, "packages/web/public"),
    plugins: [
      react(),
      tailwindcss(),
      releaseJsonPlugin({
        surface: "web-share",
        version,
        environment: nibiEnv,
        commit: env.NIBI_COMMIT,
      }),
    ],
    resolve: {
      alias: [
        { find: "@", replacement: resolve(REPO_ROOT, "packages/ui/src") },
        // Share 镜像不安装 @nibi/ui（它会带入 services/rpc 闭包），子路径导入必须显式指向源码。
        {
          find: "@nibi/ui/useTheme",
          replacement: resolve(REPO_ROOT, "packages/ui/src/useTheme.ts"),
        },
        // 只读时间线的协议子路径同时是 shareBuildBoundary 守卫的准入声明。
        {
          find: "@nibi/shared/nibi-protocol-v4",
          replacement: resolve(REPO_ROOT, "packages/shared/src/nibi-protocol-v4/index.ts"),
        },
        // Bugfix：test-ids 改为只从子路径导入后，reasoning.tsx、ToolSummaryRow.tsx 等 share 闭包
        // 文件引用了它；镜像没有 packages/ui 的依赖链接，未登记别名时 Docker 构建解析失败。
        {
          find: "@nibi/shared/test-ids",
          replacement: resolve(REPO_ROOT, "packages/shared/src/test-ids.ts"),
        },
        {
          find: "@nibi/ui/conversation-share-readonly",
          replacement: resolve(REPO_ROOT, "packages/share-ui/src/index.ts"),
        },
        // 登录卡片要用 provider 图标；只依赖 shared/lucide/cn，不引入 services/rpc。
        {
          find: "@nibi/ui/oauth-provider-icon",
          replacement: resolve(REPO_ROOT, "packages/ui/src/lib/oauthProviderIcon.tsx"),
        },
        // 偏好存储（a95a9060 之后 main.tsx 从 @nibi/ui/nibi-storage 读主题偏好）。
        // 和上面几个同理：镜像不装 @nibi/ui，子路径必须显式指向源码，否则 Rolldown 解析失败。
        {
          find: "@nibi/ui/nibi-storage",
          replacement: resolve(REPO_ROOT, "packages/ui/src/lib/nibiStorage.ts"),
        },
      ],
    },
    define: {
      __NIBI_VERSION__: JSON.stringify(version),
      __NIBI_COMMIT__: JSON.stringify(env.NIBI_COMMIT || "unknown"),
      __NIBI_ENV__: JSON.stringify(nibiEnv),
      "import.meta.env.VITE_NIBI_BASE_URL": JSON.stringify(endpointOrigin),
      "import.meta.env.VITE_NIBI_ENDPOINT_ORIGIN": JSON.stringify(endpointOrigin),
    },
    build: {
      outDir: resolve(REPO_ROOT, "packages/web-share/dist"),
      emptyOutDir: true,
      sourcemap: mode === "production" ? "hidden" : true,
    },
  };
});
