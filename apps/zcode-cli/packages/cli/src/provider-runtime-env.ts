import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  materializeZCodeBuiltinProviderConfig,
  NodeZCodeBuiltinProviderConfigSource,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  resolveZCodeBuiltinCachePaths,
  resolveZCodeBuiltinClientPlatform,
  NIBI_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV,
  NIBI_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  NIBI_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
  type ZCodeBuiltinRefreshEvent,
} from "@nibi/provider-node";
import { resolveRuntimeZCodeEndpointOrigin, NIBI_VERSION } from "@nibi/shared";
import type { CliEnv } from "./env.js";

export const SEA_NIBI_BUILTIN_PROVIDER_CONFIG_ASSET_KEY = "nibi-provider/nibi-builtin.json";

export function createCliProviderRefreshReporter(
  stderr: Pick<NodeJS.WriteStream, "write"> = process.stderr,
) {
  return {
    onBuiltinRefreshError(error: unknown) {
      stderr.write(
        `ZCode Built-in 刷新失败: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
    },
    onBuiltinRefreshResult(event: ZCodeBuiltinRefreshEvent) {
      // TTL 检查不是生产事件；成功更新才默认留痕，不能输出 CDN URL 查询参数或内容。
      if (event.result === "updated" || process.env.NODE_ENV !== "production") {
        stderr.write(
          `ZCode Built-in ${event.result}${event.reason ? ` (${event.reason})` : ""}${event.revision === undefined ? "" : ` revision=${event.revision} source=CDN`}\n`,
        );
      }
    },
  };
}

type SeaProviderConfigAssets = Pick<typeof import("node:sea"), "getAsset" | "isSea">;

interface PrepareCliProviderRuntimeEnvOptions {
  readonly argv: readonly string[];
  readonly env: CliEnv;
  readonly dataBaseDir?: string;
  readonly entrypoint?: string;
  readonly sea?: SeaProviderConfigAssets;
  readonly appVersion?: string;
  readonly platform?: string;
}

/**
 * 数据根接管：显式给了数据根就丢弃继承来的 Provider Config 派生路径。
 *
 * 适用**用户在终端里亲自敲的入口**（TUI，以及 `-p/--prompt`、`--target` 提示模式）。
 *
 * TUI 与提示模式常从桌面端派生的终端启动，会继承桌面端定向注入的
 * `NIBI_*_PROVIDER_CONFIG_FILE`；而 `prepareCliProviderRuntimeEnv` 见到这两个变量就直接
 * 返回它们，整段跳过数据根推导 —— 于是用户显式指定的 `NIBI_DATA_BASE_DIR` /
 * `NIBI_STORAGE_DIR` 被静默无视。实测后果：隔离运行把 personal provider 与默认模型写进了
 * 真实的 `~/.nibi/v2`，覆盖了桌面端正在用的那份配置，`/model` 面板也照样列出桌面端的
 * 全部 provider；更糟的是**跑一轮消耗的是用户自己的额度**（自动化端到端测试正是踩在这里，
 * 直到 402 Insufficient Balance 才暴露）。
 *
 * 这两个变量是**派生路径**，数据根才是权威：命令行里只要给了数据根，就丢弃继承来的派生
 * 路径并按数据根重算。
 *
 * 只给用户入口用。桌面端正是靠定向注入这两个变量把 app-server / agent-server 子进程指到
 * 自己的配置上，那条调用路径必须原样保留。
 *
 * @returns 需要显式传给 `prepareCliProviderRuntimeEnv` 的数据根（没有显式数据根时为空对象）。
 */
export function takeOverInheritedProviderConfigPaths(env: CliEnv): {
  readonly dataBaseDir?: string;
} {
  const dataBaseDir = env.NIBI_DATA_BASE_DIR?.trim() || env.NIBI_STORAGE_DIR?.trim();
  if (!dataBaseDir) return {};
  delete env[NIBI_BUILTIN_PROVIDER_CONFIG_FILE_ENV];
  delete env[NIBI_PERSONAL_PROVIDER_CONFIG_FILE_ENV];
  return { dataBaseDir };
}

/** 为运行 Core 或写入模型选择的 CLI Entry 定位同一 Environment 的 Provider Config。 */
export async function prepareCliProviderRuntimeEnv(
  options: PrepareCliProviderRuntimeEnvOptions,
): Promise<Record<string, string>> {
  if (!requiresProviderRuntime(options.argv)) return {};

  const explicitZCodeBuiltin = options.env[NIBI_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const explicitPersonal = options.env[NIBI_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const dataBaseDir =
    options.dataBaseDir ??
    options.env.NIBI_DATA_BASE_DIR?.trim() ??
    options.env.NIBI_STORAGE_DIR?.trim() ??
    homedir();
  if (explicitZCodeBuiltin && explicitPersonal) {
    return {
      [NIBI_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: explicitZCodeBuiltin,
      [NIBI_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: explicitPersonal,
    };
  }

  const nibiBuiltinFilePath =
    explicitZCodeBuiltin ??
    (await resolveBundledZCodeBuiltinProviderConfig({
      dataBaseDir,
      entrypoint: options.entrypoint ?? process.argv[1],
      sea: options.sea ?? getSeaProviderConfigAssets(),
    }));
  const personalFilePath =
    explicitPersonal ?? join(dataBaseDir, ".nibi", "v2", PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  const appVersion = options.appVersion ?? NIBI_VERSION;
  const platform = options.platform ?? resolveZCodeBuiltinClientPlatform();
  const zcodeEndpointOrigin = resolveRuntimeZCodeEndpointOrigin(options.env);
  const cachePaths = resolveZCodeBuiltinCachePaths({
    environmentConfigRoot: join(dataBaseDir, ".nibi", "v2"),
    platform,
    appVersion,
    zcodeEndpointOrigin,
  });
  const source = new NodeZCodeBuiltinProviderConfigSource({
    bundledFilePath: nibiBuiltinFilePath,
    activeFilePath: cachePaths.activeFilePath,
    watch: false,
  });
  // 入口只准备资源和路径；下载由 Prompt/TUI 长生命周期 Runtime 持有并取消。
  try {
    await source.read();
  } finally {
    source.dispose();
  }

  return {
    [NIBI_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: cachePaths.activeFilePath,
    [NIBI_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV]: nibiBuiltinFilePath,
    [NIBI_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: personalFilePath,
  };
}

function requiresProviderRuntime(argv: readonly string[]): boolean {
  if (argv.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v")) {
    return false;
  }
  if (
    argv.some(
      (arg) =>
        arg === "--prompt" ||
        arg.startsWith("--prompt=") ||
        arg === "--target" ||
        arg.startsWith("--target="),
    )
  ) {
    return true;
  }

  const command = argv[0];
  if (command === undefined || command.startsWith("-")) return true;
  return (
    command === "tui" ||
    command === "app-server" ||
    command === "agent-server" ||
    command === "login" ||
    command === "logout"
  );
}

async function resolveBundledZCodeBuiltinProviderConfig(input: {
  readonly dataBaseDir: string;
  readonly entrypoint: string | undefined;
  readonly sea: SeaProviderConfigAssets | undefined;
}): Promise<string> {
  if (input.sea?.isSea()) {
    const content = input.sea.getAsset(SEA_NIBI_BUILTIN_PROVIDER_CONFIG_ASSET_KEY, "utf8");
    return materializeZCodeBuiltinProviderConfig({
      environmentConfigRoot: join(input.dataBaseDir, ".nibi", "v2"),
      content,
    });
  }

  const entrypoint = input.entrypoint?.trim();
  if (!entrypoint) throw new Error("无法定位 CLI ZCode Built-in Provider Config：缺少入口路径");
  // 全局 bin 可以是软链接，随包配置必须相对真实入口定位。
  const entryDirectory = dirname(realpathSync(resolve(entrypoint)));
  const candidates = [
    join(entryDirectory, "provider", "nibi-builtin.json"),
    resolve(entryDirectory, "../../../../../config/provider/nibi-builtin.json"),
  ];
  const candidate = candidates.find((filePath) => existsSync(filePath));
  if (candidate) return candidate;
  throw new Error(`无法定位 CLI ZCode Built-in Provider Config：${candidates.join(", ")}`);
}

function getSeaProviderConfigAssets(): SeaProviderConfigAssets | undefined {
  const getBuiltinModule = process.getBuiltinModule as
    | ((id: "node:sea") => typeof import("node:sea"))
    | undefined;
  return getBuiltinModule?.("node:sea");
}
