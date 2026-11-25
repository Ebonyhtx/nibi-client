/**
 * 原生模块检测（计划 E §8.4）。
 *
 * 为什么必须在激活前拦：`.node` 是绑定 OS/架构/Node ABI 的二进制。第三方插件带着
 * 为别的 ABI 编的原生模块时，宿主只会在真正 require 的瞬间抛 `NODE_MODULE_VERSION`
 * 这类底层错误——用户看到的是「插件坏了」，而不是「这个插件不能用，原因是什么」。
 * 更重要的是：原生模块是**完全在能力网关之外**的代码面（进程内 C++），
 * 因此规则是「声明了才允许尝试」，没声明一律 blocked。
 *
 * 检测只做静态扫描 + 平台/ABI 声明比对，不在这里 require 任何东西：
 * 发现层是同步热路径，加载探针由扩展宿主在激活时做。
 */
import { readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import type { PluginRuntimeDeclaration } from "@nibi/contracts";

/** 单次扫描的文件数上限：防止超大 node_modules 让同步发现卡住。 */
const NATIVE_SCAN_MAX_ENTRIES = 20_000;
/** 不进入的目录：这些位置的原生模块不参与运行时加载。 */
const SKIP_DIRECTORIES = new Set([".git", ".cache", "test", "tests", "__tests__", "docs"]);

export interface NativeModuleScanResult {
  /** 相对插件根的 POSIX 路径，升序。 */
  files: string[];
  /** 扫描是否因条目上限被截断；true 时不要据此判定「没有原生模块」。 */
  truncated: boolean;
}

/**
 * 扫描插件根下的 `*.node`。
 *
 * 只跟随真实目录，不跟随符号链接：插件包里的链接可以指到插件根以外
 * （包括用户主目录），扫进去等于让插件把宿主文件系统当成自己的包内容。
 */
export function scanPluginNativeModules(rootPath: string): NativeModuleScanResult {
  const files: string[] = [];
  let visited = 0;
  let truncated = false;
  const walk = (relativeDir: string): void => {
    if (truncated) return;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(relativeDir ? join(rootPath, relativeDir) : rootPath, {
        encoding: "utf8",
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      visited += 1;
      if (visited > NATIVE_SCAN_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(relativePath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".node")) {
        files.push(relativePath);
      }
    }
  };
  walk("");
  return { files: files.sort(), truncated };
}

export type NativeModuleVerdict =
  | { status: "none" }
  /** 包里有 .node，但清单没声明 `runtime.native: true`。 */
  | { status: "undeclared"; files: string[] }
  /** 声明了原生模块，但当前平台不在 `runtime.platforms` 里。 */
  | { status: "platform_unsupported"; files: string[]; platform: string }
  /** 声明了原生模块但当前宿主运行时无法加载（桌面扩展宿主 = Electron ABI）。 */
  | { status: "abi_unsupported"; files: string[]; reason: string }
  /** 声明完整且当前平台支持；由扩展宿主在激活时做加载探针。 */
  | { status: "declared"; files: string[] };

export interface NativeModuleCheckInput {
  rootPath: string;
  runtime: PluginRuntimeDeclaration | undefined;
  /** `process.platform`-`process.arch`，例如 `win32-x64`；测试可注入。 */
  platform?: string;
  /**
   * 扩展宿主运行时类型。桌面宿主跑在 Electron 内，Node ABI 与官方 Node 不同；
   * `runtime.native` 的插件只能按 Electron ABI 编（见计划 §8.4）。
   */
  hostKind?: "electron" | "node";
}

/**
 * 判定原生模块可用性。返回 `blocked` 的调用方必须把插件标成不可激活代码
 * （声明式组件仍可用），而不是让它在运行时崩。
 *
 * 规则来源（计划 §8.4）：
 * - 有 `.node` 但未声明 `native: true` → 拒绝；
 * - 声明了 `platforms` 且不含当前平台 → 拒绝；
 * - 扩展宿主只支持按 Electron ABI 编译的模块；声明了 `napi` 的模块跨 ABI 兼容，
 *   因此放行（N-API 不绑定 NODE_MODULE_VERSION），未声明 `napi` 的按 ABI 不匹配处理。
 */
export function checkPluginNativeModules(input: NativeModuleCheckInput): NativeModuleVerdict {
  const scan = scanPluginNativeModules(input.rootPath);
  if (scan.files.length === 0) {
    // 截断时不能断言「没有原生模块」：宁可报 ABI 不支持让用户看诊断，
    // 也不要放行一个可能有原生代码的插件。
    return scan.truncated
      ? {
          files: [],
          reason: "native module scan was truncated; cannot prove the package has no native code",
          status: "abi_unsupported",
        }
      : { status: "none" };
  }
  const runtime = input.runtime;
  if (runtime?.native !== true) {
    return { files: scan.files, status: "undeclared" };
  }
  const platform = input.platform ?? `${process.platform}-${process.arch}`;
  if (runtime.platforms && runtime.platforms.length > 0 && !runtime.platforms.includes(platform)) {
    return { files: scan.files, platform, status: "platform_unsupported" };
  }
  // `napi` 声明的模块按 N-API 版本工作，不依赖 NODE_MODULE_VERSION；没有声明的
  // 老式原生模块在 Electron 宿主里几乎必然 ABI 不匹配，直接按不可用处理。
  if ((input.hostKind ?? "electron") === "electron" && runtime.napi === undefined) {
    return {
      files: scan.files,
      reason:
        "native module must declare `runtime.napi` to load inside the Electron host (Node ABI differs)",
      status: "abi_unsupported",
    };
  }
  return { files: scan.files, status: "declared" };
}

/** 目录是否存在；供调用方在扫描前短路。 */
export function isPluginRootDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** 安装/更新期拒绝：包内有 `.node` 但清单没声明 `runtime.native: true`。 */
export class PluginNativeModuleInstallError extends Error {
  constructor(
    readonly pluginId: string,
    message: string,
  ) {
    super(message);
    this.name = "PluginNativeModuleInstallError";
  }
}

/**
 * 安装/更新期的原生模块门禁（计划 §8.4）。
 *
 * 为什么要在安装时拦：发现层的 `codeBlockedReason` 只影响「加载」——包已经落盘、
 * 安装记录也写了，用户看到的是「装上了但用不了」。计划要求安装期就拒绝，让失败
 * 发生在产生任何安装状态之前（调用方在原子事务里，抛错会回滚缓存目录）。
 *
 * 只在**确实扫到 `.node`** 时拒绝。扫描被截断（超大包）但不含可见 `.node` 时放行：
 * 拒绝一个纯声明式的大包是把「可能有原生模块」当成「一定有」；发现层对截断仍按
 * ABI 不支持保守挡代码，声明式组件不受影响。
 */
export function assertPluginNativeModulesDeclared(input: {
  /** 清单是否声明了 `runtime.native: true`（调用方负责从原始 JSON 里读，避免为它放宽类型）。 */
  nativeDeclared: boolean;
  pluginId: string;
  rootPath: string;
}): void {
  if (input.nativeDeclared) return;
  const scan = scanPluginNativeModules(input.rootPath);
  if (scan.files.length === 0) return;
  throw new PluginNativeModuleInstallError(
    input.pluginId,
    `Plugin ships native modules without declaring runtime.native: ${scan.files
      .slice(0, 3)
      .join(", ")}`,
  );
}
