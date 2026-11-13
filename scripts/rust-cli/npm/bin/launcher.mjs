// `@nibi-studio/cli` META 包的启动器。发布时原样复制到包的 `bin/launcher.mjs`，
// 由 `bin/nibi.js` 调用；测试直接 import 这里的纯函数。
//
// 约束：
// - 只依赖 Node 标准库，不假设调用方安装了任何 workspace 依赖；
// - 平台包由 npm 的 optionalDependencies 安装，缺失时 fail-closed（退出码 1），
//   不能静默回退到别的架构或 Node CLI；
// - 子进程必须继承 stdio 与信号转发，交互式 `nibi` / `nibi-rs` 的 TTY 行为不变；
// - 子进程环境带 `NIBI_MANAGED_*` 标记，Rust 的 `nibi update` 才能识别安装方式。

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";

export const META_PACKAGE_NAME = "@nibi-studio/cli";

/** 已发布的平台包：键是 Node 的 `${process.platform}-${process.arch}`。 */
export const PLATFORM_PACKAGES = Object.freeze({
  "linux-x64": "@nibi-studio/cli-linux-x64-gnu",
  "linux-arm64": "@nibi-studio/cli-linux-arm64-gnu",
  "darwin-arm64": "@nibi-studio/cli-darwin-arm64",
  "android-arm64": "@nibi-studio/cli-android-arm64",
});

/** 与 Rust 端 `update::install::MARKERS` 的顺序一致（pnpm 先于 npm，npm 先于 bun）。 */
const MANAGER_MARKERS = Object.freeze([
  ["NIBI_MANAGED_BY_PNPM", "pnpm"],
  ["NIBI_MANAGED_BY_NPM", "npm"],
  ["NIBI_MANAGED_BY_BUN", "bun"],
]);

/** 转发给子进程的信号。SIGBREAK 只在 Windows 有意义，而 Windows 没有平台包。 */
export const FORWARDED_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]);

/**
 * 返回本机应使用的平台包名；不支持的平台直接抛错（错误文本面向终端用户）。
 */
export function platformPackageName({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const key = `${platform}-${arch}`;
  const packageName = PLATFORM_PACKAGES[key];
  if (!packageName) {
    throw new Error(
      `unsupported platform ${key}; supported platforms: ${Object.keys(PLATFORM_PACKAGES).join(", ")}`,
    );
  }
  return packageName;
}

/**
 * 从启动器自己的安装位置解析平台包里的 `bin/nibi-rs`。
 *
 * `requireFrom` 必须是文件 URL（默认是启动器自身）。npm/pnpm/bun 的全局安装都会把
 * optionalDependencies 放在入口包可解析的位置，因此不需要遍历 PATH 或硬编码安装目录。
 */
export function resolvePlatformBinary({
  platform = process.platform,
  arch = process.arch,
  requireFrom = import.meta.url,
} = {}) {
  const packageName = platformPackageName({ platform, arch });
  const require = createRequire(requireFrom);
  try {
    return {
      packageName,
      binaryPath: require.resolve(`${packageName}/bin/nibi-rs`),
    };
  } catch (cause) {
    throw new Error(
      `the ${packageName} package is not installed for ${platform}-${arch}; reinstall ${META_PACKAGE_NAME} with optional dependencies enabled`,
      { cause },
    );
  }
}

function launcherPath(launcherUrl) {
  try {
    return fileURLToPath(launcherUrl).replaceAll("\\", "/");
  } catch {
    return String(launcherUrl).replaceAll("\\\\", "/").replaceAll("\\", "/");
  }
}

/**
 * 识别安装入口来自哪个包管理器。npm 是默认值；pnpm/bun 的全局布局在路径里带
 * `pnpm` / `.bun`，`npm_config_user_agent` 覆盖通过包管理器脚本启动的情况。
 * 父进程已经给了标记时保持不变，避免覆盖更准确的来源。
 */
export function detectManagerMarker({ env = process.env, launcherUrl = import.meta.url } = {}) {
  for (const [marker] of MANAGER_MARKERS) {
    if (env[marker] !== undefined) return marker;
  }

  const userAgent = env.npm_config_user_agent ?? "";
  if (/^pnpm\//u.test(userAgent)) return "NIBI_MANAGED_BY_PNPM";
  if (/^bun\//u.test(userAgent)) return "NIBI_MANAGED_BY_BUN";

  const normalized = launcherPath(launcherUrl);
  if (/(?:^|\/)\.bun(?:\/|$)|(?:^|\/)bun\/install\/global(?:\/|$)/u.test(normalized)) {
    return "NIBI_MANAGED_BY_BUN";
  }
  if (/(?:^|\/)pnpm(?:\/|$)/u.test(normalized)) {
    return "NIBI_MANAGED_BY_PNPM";
  }
  return "NIBI_MANAGED_BY_NPM";
}

/** 子进程环境：安装方式标记 + 入口包名 + 本机平台包名（Rust `nibi update` 约定）。 */
export function managedEnvironment({
  platformPackage,
  packageName = META_PACKAGE_NAME,
  env = process.env,
  launcherUrl = import.meta.url,
} = {}) {
  if (!platformPackage) {
    throw new Error("managedEnvironment requires the resolved platform package name");
  }
  const marker = detectManagerMarker({ env, launcherUrl });
  return {
    ...env,
    [marker]: "1",
    NIBI_MANAGED_PACKAGE: packageName,
    NIBI_MANAGED_PLATFORM_PACKAGE: platformPackage,
  };
}

/**
 * 把进程收到的终止信号转发给子进程；返回解除监听函数。
 *
 * `processRef` 只用于测试（传入 EventEmitter），生产路径就是全局 `process`。
 */
export function forwardSignals(child, { processRef = process, signals = FORWARDED_SIGNALS } = {}) {
  const handlers = new Map();
  for (const signal of signals) {
    const handler = () => {
      // 子进程可能已经退出；kill 返回 false 或抛 ESRCH 都不算启动器错误。
      try {
        child.kill(signal);
      } catch {
        // 交给子进程的 exit/error 事件决定最终退出码。
      }
    };
    handlers.set(signal, handler);
    processRef.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      processRef.off(signal, handler);
    }
  };
}

function exitCodeFor(signal) {
  const number = osConstants.signals?.[signal];
  return number ? 128 + number : 1;
}

/**
 * 启动平台包里的 `nibi-rs`。错误只写 stderr 并设置退出码，不向调用方抛异常
 * （`process.exitCode` 会由 Node 在事件循环清空后带出）。
 */
export function runLauncher({
  argv = process.argv.slice(2),
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  requireFrom = import.meta.url,
  spawnImpl = spawn,
  stderr = process.stderr,
} = {}) {
  let resolved;
  try {
    resolved = resolvePlatformBinary({ platform, arch, requireFrom });
  } catch (error) {
    stderr.write(`nibi: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return undefined;
  }

  const childEnv = managedEnvironment({
    platformPackage: resolved.packageName,
    env,
    launcherUrl: requireFrom,
  });

  let child;
  try {
    child = spawnImpl(resolved.binaryPath, argv, {
      env: childEnv,
      // inherit 同时覆盖 stdin/stdout/stderr：TUI/交互提示与 `--json` 输出都不改变语义。
      stdio: "inherit",
    });
  } catch (error) {
    stderr.write(
      `nibi: failed to launch ${resolved.packageName}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return undefined;
  }

  const stopForwarding = forwardSignals(child);
  child.once("error", (error) => {
    stopForwarding();
    stderr.write(
      `nibi: failed to launch ${resolved.packageName}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    stopForwarding();
    process.exitCode = signal ? exitCodeFor(signal) : (code ?? 1);
  });
  return child;
}
