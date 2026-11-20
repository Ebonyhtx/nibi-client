export interface CuaHelperRecipe {
  command: string;
  entryPath: string;
  root: string;
  addonPath: string;
  commandEnv: Record<string, string>;
}

/** 日志接口：只依赖 info/warn，避免把宿主的 logger 类型拖进来。 */
export interface CuaHelperLauncherLogger {
  info?: (message: string, meta?: unknown) => void;
  warn?: (message: string, meta?: unknown) => void;
}

export interface CuaHelperHandle {
  child: import("node:child_process").ChildProcess;
  socketPath: string;
}

export interface CuaHelperLauncher {
  /** 配方与 socket 都具备时才为 true；false 时调用方应保持 fail-closed。 */
  available: boolean;
  /** available=false 的原因（指出缺哪个环境变量），用于诊断。 */
  reason: string | undefined;
  /** 幂等地确保 Helper 已起：并发只 fork 一次；成功后再调是空操作；失败可重试。 */
  ensure(): Promise<void>;
}

export declare const HELPER_RECIPE_ENV: string;
export declare const HELPER_ADDON_ENV: string;
export declare const HELPER_CONTROL_PROTOCOL: string;

export declare function parseHelperRecipe(raw: unknown): CuaHelperRecipe | null;

export declare function spawnCuaHelper(options: {
  recipe: CuaHelperRecipe | null;
  socketPath: string;
  parentPid?: number;
  transportReadyMs?: number;
  readyMs?: number;
  logger?: CuaHelperLauncherLogger;
  spawnImpl?: typeof import("node:child_process").spawn;
}): Promise<CuaHelperHandle>;

export declare function createHelperLauncher(options?: {
  socketPath?: string;
  env?: Record<string, string | undefined>;
  logger?: CuaHelperLauncherLogger;
  spawnImpl?: typeof import("node:child_process").spawn;
}): CuaHelperLauncher;
