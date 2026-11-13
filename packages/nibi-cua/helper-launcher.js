/**
 * Helper 自拉（SDK 侧"首次 CUA 调用"路径）。
 *
 * 为什么需要它（2026-10-13 实测）：上游 v3.15.1 把 Computer Use Helper 改成**懒启动**，
 * 规范（`docs/cua-permission-broker/2026-09-21-cua-helper-lazy-startup-spec.md`）写明
 * "Helper 的合法启动触发者只有三类，其中 **Agent 首次 CUA 调用的 SDK ensureBrokerAvailable
 * 是唯一的首调路径**"。上游把 Host 侧那一半开源了（只把"配方"当纯数据注入 spawn env），
 * 但**自拉这一半不在开源树里**——于是我们 fork 里没有任何东西消费
 * `NIBI_CUA_WIN_HELPER_RECIPE`，Helper 永远不会起来，每次 CUA 调用都以
 * `broker_not_accepting` 收场。
 *
 * 这个模块就是补上那一半：拿到配方 → fork Helper → 等它把 socket 绑好（`transport_ready`）
 * → 之后调用方按原路径重试一次即可。
 *
 * 契约（与宿主侧 `windowsCuaDevHelperHost.ts` 的 fork 参数逐项对齐，两处必须一致）：
 *   argv : <entryPath> --socket <pipe> --parent-pid <pid>
 *   cwd  : root
 *   env  : commandEnv + NIBI_CUA_HELPER_ADDON=<addonPath> + ELECTRON_RUN_AS_NODE=1
 *   握手 : process.send({protocol:"nibi-cua-windows-dev/v1", type:"transport_ready"|"ready"|"error"})
 *
 * 为什么可以 fork（而不是必须由宿主做）：SDK 与 Helper 在同一个进程树里——node_repl
 * host 由 agent 派生，而 agent 的 spawn env 里已经带了配方；SDK 只是把它执行掉。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/** 宿主注入"配方"的环境变量名（与 packages/services/src/node.ts 注入侧同名）。 */
export const HELPER_RECIPE_ENV = "NIBI_CUA_WIN_HELPER_RECIPE";
/** Helper 原生件路径（宿主侧 HELPER_ADDON_ENV 同名）。 */
export const HELPER_ADDON_ENV = "NIBI_CUA_HELPER_ADDON";
/** 与宿主同口径的握手协议标识。 */
export const HELPER_CONTROL_PROTOCOL = "nibi-cua-windows-dev/v1";

/** 等待 transport_ready 的预算：Helper 要先绑 pipe 再异步加载引擎，给足冷启动时间。 */
const DEFAULT_TRANSPORT_READY_MS = 15_000;
/** 引擎就绪（ready）的额外预算：首帧截图/原生件加载较慢。 */
const DEFAULT_READY_MS = 45_000;

/**
 * 解析宿主注入的配方。解析不出或字段不全会返回 null（调用方据此保持 fail-closed，
 * 绝不猜路径——猜错会 fork 一个不存在的入口，报错更难查）。
 */
export function parseHelperRecipe(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const command = typeof value.command === "string" ? value.command.trim() : "";
  const entryPath = typeof value.entryPath === "string" ? value.entryPath.trim() : "";
  const root = typeof value.root === "string" ? value.root.trim() : "";
  if (!command || !entryPath || !root) return null;
  const addonPath = typeof value.addonPath === "string" ? value.addonPath.trim() : "";
  const commandEnv =
    value.commandEnv && typeof value.commandEnv === "object" && !Array.isArray(value.commandEnv)
      ? Object.fromEntries(
          Object.entries(value.commandEnv).filter(([, v]) => typeof v === "string"),
        )
      : {};
  return { command, entryPath, root, addonPath, commandEnv };
}

/**
 * 起一个 Helper 并等它绑好 socket。
 *
 * 返回 { child, socketPath }；失败抛错（调用方负责把它翻成 CUA_NOT_READY 之类的对外错误码）。
 * 注意：**这里不做健康检查**——只等握手消息。健康是后续 broker 调用的事，
 * 而按上游不变量，spawn 路径不得引入健康 IO。
 */
export function spawnCuaHelper({
  recipe,
  socketPath,
  parentPid = process.pid,
  transportReadyMs = DEFAULT_TRANSPORT_READY_MS,
  readyMs = DEFAULT_READY_MS,
  logger,
  spawnImpl = spawn,
}) {
  if (!recipe) return Promise.reject(new Error("missing helper recipe"));
  if (!socketPath) return Promise.reject(new Error("missing broker socket path"));

  const argv = [recipe.entryPath, "--socket", socketPath, "--parent-pid", String(parentPid)];
  const env = {
    ...process.env,
    ...recipe.commandEnv,
    ...(recipe.addonPath ? { [HELPER_ADDON_ENV]: recipe.addonPath } : {}),
    // 桌面打包态的 command 是 Electron 可执行文件；不带这个标志会误进 Electron main。
    ELECTRON_RUN_AS_NODE: "1",
  };

  let child;
  try {
    child = spawnImpl(recipe.command, argv, {
      cwd: recipe.root,
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let transportTimer;
    let readyTimer;

    const cleanup = () => {
      if (transportTimer) clearTimeout(transportTimer);
      if (readyTimer) clearTimeout(readyTimer);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        child.kill();
      } catch {
        // 进程可能已退出。
      }
      reject(error);
    };
    const succeed = (stage) => {
      if (settled) return;
      settled = true;
      cleanup();
      logger?.info?.(`CUA helper ${stage}`, { pid: child.pid, socketPath });
      resolve({ child, socketPath });
    };

    // 先等 transport_ready：那一刻 socket 已绑定，后续 broker 调用才有意义。
    // ready（引擎加载完）作为第二阶段——上游口径里 transport_ready 已足以对外承诺凭据，
    // 引擎加载慢只影响首次操作耗时，不该让 spawn 失败。
    transportTimer = setTimeout(() => {
      fail(new Error(`CUA helper did not report transport_ready within ${transportReadyMs}ms`));
    }, transportReadyMs);
    readyTimer = setTimeout(() => {
      // 引擎超时不算致命：socket 已可用，让调用方自己按 broker 错误码处理。
      logger?.warn?.("CUA helper engine not ready within budget", { pid: child.pid });
      succeed("transport_ready (engine pending)");
    }, readyMs);

    child.on?.("message", (message) => {
      if (!message || typeof message !== "object") return;
      if (message.protocol !== HELPER_CONTROL_PROTOCOL) return;
      if (message.type === "error") {
        fail(new Error(`CUA helper reported error: ${message.message ?? "unknown"}`));
        return;
      }
      if (message.type === "transport_ready") {
        // 校验 socket 与 pid：防止拿到别的代际/别的进程的握手（宿主侧有同样校验）。
        if (message.socketPath && message.socketPath !== socketPath) {
          fail(new Error("CUA helper reported a different socket path"));
          return;
        }
        if (typeof message.pid === "number" && child.pid && message.pid !== child.pid) {
          fail(new Error("CUA helper reported a different pid"));
          return;
        }
        succeed("transport_ready");
        return;
      }
      if (message.type === "ready") {
        // transport_ready 已 resolve 时这里是空操作（settled）。
        succeed("ready");
      }
    });

    child.on?.("error", (error) => fail(error));
    child.on?.("exit", (code, signal) => {
      fail(
        new Error(
          `CUA helper exited before transport_ready (code=${String(code)} signal=${String(signal)})`,
        ),
      );
    });
  });
}

/**
 * 幂等的"确保 broker 可用"工厂：多次调用只 fork 一次，成功后记住结果。
 *
 * 为什么需要幂等：运行时在**每次** BrokerError 时都会调用 ensureBrokerAvailable，
 * 而 CUA 会话里会有很多次调用——不记住就会 fork 出一堆 Helper 抢同一个 pipe。
 */
export function createHelperLauncher({ socketPath, env = process.env, logger, spawnImpl } = {}) {
  const recipe = parseHelperRecipe(env[HELPER_RECIPE_ENV]);
  let inflight = null;
  let done = false;

  return {
    /** 配方是否可用（不可用时调用方应保持 fail-closed，而不是每次重试都白跑一遍）。 */
    available: Boolean(recipe) && Boolean(socketPath),
    reason: !recipe
      ? `${HELPER_RECIPE_ENV} 不存在或不可解析（宿主未注入配方）`
      : !socketPath
        ? "broker socket 路径为空"
        : undefined,
    ensure() {
      if (done) return Promise.resolve();
      if (inflight) return inflight;
      if (!recipe) {
        return Promise.reject(
          new Error(`${HELPER_RECIPE_ENV} 不存在或不可解析（宿主未注入配方）`),
        );
      }
      if (!socketPath) return Promise.reject(new Error("broker socket 路径为空"));
      // 已经有一个 Helper 在监听这个 pipe（例如上一个 agent 留下的）：
      // 直接算成功，避免 fork 第二个进程去抢同一个 pipe。
      if (process.platform === "win32" && existsSync(socketPath)) {
        done = true;
        return Promise.resolve();
      }
      inflight = spawnCuaHelper({ recipe, socketPath, logger, ...(spawnImpl ? { spawnImpl } : {}) })
        .then((handle) => {
          done = true;
          inflight = null;
          // Helper 退出后允许下一次调用重新拉起（standalone 300s idle 自退是特性）。
          handle.child.on?.("exit", () => {
            done = false;
          });
        })
        .catch((error) => {
          inflight = null;
          throw error;
        });
      return inflight;
    },
  };
}
