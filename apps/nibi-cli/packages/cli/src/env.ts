import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import {
  NIBI_RUNTIME_ENV_KEY,
  buildNibiToolEnvPassthroughEnv,
  normalizeNibiRuntimeEnv,
  sanitizeNibiRuntimeEnv,
  sanitizeNibiRuntimeEnvInPlace,
  type NibiRuntimeEnv,
} from "@nibi/shared/runtime-env";

export type CliEnv = Record<string, string | undefined>;

export type DotenvLoadResult = {
  error?: Error;
  keys: string[];
  loaded: boolean;
  path?: string;
};

export type LoadCliDotenvOptions = {
  cwd?: string;
  env?: CliEnv;
};

export function prepareCliRuntimeEnv(
  env: CliEnv = process.env,
  argv: readonly string[] = process.argv,
): CliEnv {
  const prepared = {
    ...sanitizeNibiRuntimeEnv(env),
    ...buildNibiToolEnvPassthroughEnv(env),
  };
  applyCliRuntimeEnvDefaults(prepared, argv);
  return prepared;
}

export function applyCliRuntimeEnvSanitization(
  env: CliEnv,
  argv: readonly string[] = process.argv,
): void {
  const toolEnvPassthrough = buildNibiToolEnvPassthroughEnv(env);
  sanitizeNibiRuntimeEnvInPlace(env);
  Object.assign(env, toolEnvPassthrough);
  applyCliRuntimeEnvDefaults(env, argv);
}

export const findDotenv = (startDir: string): string | undefined => {
  let current = resolve(startDir);
  const root = parse(current).root;

  while (true) {
    const candidate = resolve(current, ".env");
    // 用户可能把 .env 当作目录使用（如 ~/.env/modelscope）。
    // existsSync 只检查存在性，不区分文件/目录；必须显式检查 isFile避免 loadDotenv 报错。
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }

    if (current === root) {
      return undefined;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
};

export const loadCliDotenv = (options: LoadCliDotenvOptions = {}): DotenvLoadResult => {
  const env = options.env ?? process.env;
  const dotenvPath = findDotenv(options.cwd ?? process.cwd());

  if (!dotenvPath) {
    return {
      keys: [],
      loaded: false,
    };
  }

  // The build used to inline .env values into dist. Loading at the CLI boundary
  // keeps secrets runtime-scoped and lets users rotate .env without rebuilding.
  const result = loadDotenv({
    override: false,
    path: dotenvPath,
    processEnv: env,
    quiet: true,
  });

  if (result.error) {
    return {
      error: result.error,
      keys: [],
      loaded: false,
      path: dotenvPath,
    };
  }

  return {
    keys: Object.keys(result.parsed ?? {}),
    loaded: true,
    path: dotenvPath,
  };
};

export function shouldLoadCliDotenvForProtocolServer(env: CliEnv): boolean {
  return resolveCliRuntimeEnv(env, process.argv) === "development";
}

function applyCliRuntimeEnvDefaults(env: CliEnv, argv: readonly string[]): void {
  env[NIBI_RUNTIME_ENV_KEY] = resolveCliRuntimeEnv(env, argv);
  applyBetaStorageDefault(env);
}

function resolveCliRuntimeEnv(env: CliEnv, argv: readonly string[]): NibiRuntimeEnv {
  const explicit = normalizeNibiRuntimeEnv(env[NIBI_RUNTIME_ENV_KEY]);
  if (explicit) {
    return explicit;
  }

  // CLI 运行时不再读取 NODE_ENV。源码 tsx 入口仍表示本地开发形态，
  // 但该判定来自入口路径，不来自用户 shell 里的 NODE_ENV。
  const entrypoint = (argv[1] ?? "").replace(/\\/g, "/");
  return entrypoint.endsWith(".ts") && entrypoint.includes("packages/cli/src")
    ? "development"
    : "production";
}

function applyBetaStorageDefault(env: CliEnv): void {
  if (env.NIBI_STORAGE_DIR?.trim()) return;
  // 只认显式开关。上游 CLI 还会按可执行文件名 `nibi-beta` 推断 beta 通道，
  // 但我们的发行物只有一个 `nibi`（`package.json` 的 bin 只有它），那条分支永远走不到，
  // 却会让任何人把二进制改名成上游名字就改变存储根。删掉，不留上游文件名能触发的真分支。
  if (env.NIBI_BETA !== "1" && env.NIBI_ENV !== "beta") return;
  env.NIBI_STORAGE_DIR = join(homedir(), ".nibi-beta");
}
