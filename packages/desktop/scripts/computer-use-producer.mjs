import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * producer 包在 node_modules 里的候选目录名（按优先级）。
 *
 * 2026-10-26 修：scope 改名 `@zcode/*` → `@nibi/*` 后包名变成 `@nibi/cua`，而这里仍只找
 * `@zcode/zcode-cua` → 真实 producer 永远被判「未安装」→ Windows Helper 的 node_modules
 * 映射被跳过 → 装出来的包有 manifest/entry 却缺原生 addon，`resolveWindowsCuaRuntime` 失败、
 * 不注入配方，CUA 全部 fail-closed（实测 4.0.0 安装包即此状态）。
 * 旧名保留：开源占位包与历史布局仍用它们。
 */
const PRODUCER_PACKAGE_SEGMENTS = [
  ["@nibi", "cua"],
  ["@nibi", "zcode-cua"],
  ["@zcode", "zcode-cua"],
];

/**
 * 判定当前安装的 `@nibi/cua` 是闭源真实 producer 还是开源占位包。
 *
 * 闭源构建使用 workspace 内 `packages/zcode-cua` 的真实 producer；开源导出把该目录整体换成占位包，
 * 占位包在 package.json 声明 `zcodeCuaPlaceholder: true`，所有能力 fail-closed。
 * 开发、构建与打包里只服务于真实 Computer Use 的步骤（构建 Helper、暂存插件原生依赖、
 * Windows Helper 资源、打包后的 Helper 校验）都以本判定为门，检测不到真实 producer 时跳过，
 * 不能因为缺少私有产物让开源树的入口失败。规范见 docs/desktop/computer-use-producer-detection.md。
 *
 * 构建配置（electron-builder、tsup）同步求值，这里只做一次小文件同步读取。
 */
export function readComputerUseProducer({ desktopPackageRoot }) {
  // 从桌面包向上查找最近的安装：闭源 hoisted 布局在仓库根，开源占位包链接在桌面包下。
  for (let dir = resolve(desktopPackageRoot); ; dir = dirname(dir)) {
    for (const segments of PRODUCER_PACKAGE_SEGMENTS) {
      const manifestPath = resolve(dir, "node_modules", ...segments, "package.json");
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        return {
          installed: true,
          placeholder: manifest.zcodeCuaPlaceholder === true,
          manifest,
          packageRoot: dirname(manifestPath),
        };
      }
    }
    if (dirname(dir) === dir) return { installed: false, placeholder: false };
  }
}

export function isRealComputerUseProducerInstalled({ desktopPackageRoot }) {
  const producer = readComputerUseProducer({ desktopPackageRoot });
  return producer.installed && !producer.placeholder;
}
