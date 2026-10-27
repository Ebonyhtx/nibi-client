import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { isRealComputerUseProducerInstalled } from "../packages/desktop/scripts/computer-use-producer.mjs";
import { stageSharpIntoBundledAgents } from "../packages/desktop/scripts/sharp-package-assets.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

// 清单目录按宿主同一优先级探测：NIBI 自有格式在前，旧 ZCode 格式仍在用（互操作层）。
// 2026-10-26 修：身份隔离把插件清单迁到 `.nibi-plugin/`，这里只找 `.zcode-plugin/` 会误报
// 「CUA plugin manifest is missing」并让整个 agent bundle 构建失败。
const PLUGIN_MANIFEST_DIRS = [".nibi-plugin", ".zcode-plugin", ".claude-plugin", ".codex-plugin"];

export function stageDevCuaPluginRuntime({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  desktopPackageRoot = resolve(repositoryRoot, "packages", "desktop"),
  pluginRoot = resolve(repositoryRoot, "apps", "zcode-cli", "packages", "zcode-cua-plugin"),
} = {}) {
  if (env.NIBI_CUA_DEV_MODE !== "1") return [];
  // 开源占位包不提供 Computer Use 原生能力，也不随附 Sharp：没有真实 producer 时不暂存。
  if (!isRealComputerUseProducerInstalled({ desktopPackageRoot })) return [];

  const manifestPath = PLUGIN_MANIFEST_DIRS.map((dir) =>
    resolve(pluginRoot, dir, "plugin.json"),
  ).find((candidate) => existsSync(candidate));
  if (!manifestPath) {
    throw new Error(
      `[stage-dev-cua-plugin-runtime] CUA plugin manifest is missing under ${pluginRoot} ` +
        `(tried ${PLUGIN_MANIFEST_DIRS.join(", ")})`,
    );
  }

  // 修复原因：sync:cache 过去只把 Sharp 写入最终缓存，桌面重启时 bootstrap
  // 会用源码 plugin 原子替换该缓存并删除 Sharp。先补全 CUA filesystem seed source，
  // 才能让每次重建都得到可独立加载原生依赖的 CUA plugin；Browser Use 只提供
  // shared node_repl host，不再作为 CUA native 依赖的解析根目录。
  //
  // 2026-10-26：sharp 是上游闭源 CUA 插件的外部依赖；我们的开源插件与 node_repl host
  // 都不 import 它（实测 dist/mcp/server.js 里唯一的 "sharp" 是 HTML 实体名 ♯）。
  // 工作区没有装 sharp 时跳过暂存即可，不能因为一个用不到的包让整个 agent bundle 构建失败；
  // 真需要它的上游件仍会在自己的解析路径上失败，不会被这里掩盖。
  try {
    return stageSharpIntoBundledAgents({
      desktopPackageRoot,
      glmDir: pluginRoot,
      targetPlatform: {
        os: platform,
        arch,
        key: `${platform}-${arch}`,
      },
    });
  } catch (error) {
    if (/cannot resolve sharp/.test(String(error instanceof Error ? error.message : error))) {
      console.warn(
        "[stage-dev-cua-plugin-runtime] sharp 未安装，跳过原生依赖暂存（NIBI CUA 运行时不使用 sharp）",
      );
      return [];
    }
    throw error;
  }
}
