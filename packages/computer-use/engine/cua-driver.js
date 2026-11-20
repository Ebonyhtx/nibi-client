/**
 * Cua Driver 引擎适配层 —— 把 `@trycua/cua-driver` 的原生面收成我们内部的一小组方法。
 *
 * 为什么要这一层：宿主/运行时只认我们自己的工具语义（见 ../../vendor/freeall12-computer-use/
 * docs/zcode-computer-use.md），引擎是**可换的**：今天接 Cua Driver（MIT，六平台预编译），
 * 将来若换自研原生层，只换这个适配器。测试里可以喂假引擎。
 *
 * 引擎模块路径：默认 `@trycua/cua-driver`；打包/测试时用 `NIBI_CUA_ENGINE_MODULE`
 * 指向具体 entry（绝对路径或 file:// URL），与宿主侧 HELPER_ADDON_ENV 的口径一致（dev/产品两种来源）。
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENGINE_MODULE_ENV = "NIBI_CUA_ENGINE_MODULE";
/** 包根（本文件在 <包根>/engine/ 下）。 */
const PACKAGE_ROOT_URL = new URL("../", import.meta.url);

/**
 * 会携带 agent cursor 的输入工具（0.47.23 schema 都接受 `session`）。
 * overlay 是 session-owned；只有这些动作带 session，观察/启动保持无会话。
 */
const CURSOR_INPUT_TOOLS = new Set([
  "click",
  "double_click",
  "right_click",
  "drag",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "scroll",
  "invoke_menu",
  "move_cursor",
]);

/** 引擎会话 5 分钟无活动过期；提前 1 分钟刷新，避免动作落到已结束的会话上。 */
const AGENT_CURSOR_REFRESH_MS = 4 * 60 * 1000;
/** Helper 进程专属的公开会话标签（overlay 的 badge 会显示它）。 */
const AGENT_CURSOR_SESSION = `nibi-cua-${process.pid}`;

/** 引擎不可用（未安装、加载失败、平台不支持）——调用方按 fail-closed 处理，不要猜。 */
export class CuaEngineUnavailableError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "CuaEngineUnavailableError";
    this.code = options.code ?? "CUA_ENGINE_UNAVAILABLE";
  }
}

/**
 * 引擎模块位置，解析顺序：
 *   1. `NIBI_CUA_ENGINE_MODULE`（dev / 测试显式指定；打包后也可由宿主注入）；
 *   2. **相对自身**：`<包根>/node_modules/@trycua/cua-driver/dist/index.js`——打包出来的
 *      `tools/cua-helper/` 就是这个形态，生产态不依赖任何环境变量（宿主只传 ELECTRON_RUN_AS_NODE）；
 *   3. 退回裸包名（workspace 里 pnpm 的链接能解析到）。
 */
function resolveEngineModuleUrl(env, packageRootUrl) {
  const configured = (env?.[ENGINE_MODULE_ENV] ?? process.env[ENGINE_MODULE_ENV] ?? "").trim();
  if (configured) {
    if (configured.startsWith("file://") || configured.startsWith("node:")) return configured;
    return new URL(`file://${configured.replace(/\\/g, "/")}`).href;
  }
  if (packageRootUrl) {
    try {
      const staged = new URL("node_modules/@trycua/cua-driver/dist/index.js", packageRootUrl);
      if (existsSync(fileURLToPath(staged))) return staged.href;
    } catch {
      // 目录不存在就退回裸包名。
    }
  }
  return "@trycua/cua-driver";
}

/**
 * 建引擎。懒加载：模块不在（没装依赖 / 平台包缺失）时抛 CuaEngineUnavailableError，
 * 让上层保持"不可用"的失败语义，而不是假装能用。
 */
export async function createCuaDriverEngine(options = {}) {
  const env = options.env ?? process.env;
  const moduleUrl = options.moduleUrl ?? resolveEngineModuleUrl(env, PACKAGE_ROOT_URL);
  let module;
  try {
    module = await import(moduleUrl);
  } catch (error) {
    throw new CuaEngineUnavailableError(`Cua Driver 模块加载失败：${moduleUrl}`, { cause: error });
  }
  const { CuaDriver, DriverOptions, uniffiInitAsync } = module;
  if (typeof CuaDriver?.create !== "function") {
    throw new CuaEngineUnavailableError(`模块里没有 CuaDriver.create：${moduleUrl}`);
  }
  await uniffiInitAsync?.();
  const driver = CuaDriver.create(
    DriverOptions?.create
      ? DriverOptions.create({ claudeCodeCompatibility: false })
      : { claudeCodeCompatibility: false },
  );
  if (typeof driver.isAvailable === "function" && !driver.isAvailable()) {
    throw new CuaEngineUnavailableError("Cua Driver 在本平台不可用");
  }

  /**
   * Agent cursor overlay（0.47.23）：session-owned，`set_agent_cursor_enabled` 后由
   * 光标动作驱动；`move_cursor` 的 window scope 只动 overlay、不动真实指针。
   * 这里只在第一个 cursor-bearing 动作前 lazily 建会话并打开 overlay。
   *
   * **Windows 10 实测限制**：set 返回成功，但 `get_agent_cursor_state` 仍是
   * `enabled:false`/`visual_state.idle`，`move_cursor` 只更新 position（渲染层不工作）。
   * 所以"不移动真实鼠标"靠的是 `delivery_mode:"background"`（UIA Invoke/PostMessage），
   * overlay 只是附加尝试。overlay 是**可视化附加**——建会话/开 overlay 失败不拦真实
   * 输入（否则 cosmetic 故障会让 CUA 不可用），但也不会假装已启用：状态如实保留在
   * agentCursor 里，`agentCursorStatus()` 可查。
   */
  const agentCursor = {
    session: AGENT_CURSOR_SESSION,
    preparedAt: 0,
    sessionUsable: false,
    enabled: false,
    position: null,
    visualState: null,
    lastError: undefined,
  };
  let agentCursorPrep = null;

  const prepareAgentCursor = () => {
    if (Date.now() - agentCursor.preparedAt < AGENT_CURSOR_REFRESH_MS) {
      return Promise.resolve();
    }
    if (agentCursorPrep) return agentCursorPrep;
    agentCursorPrep = (async () => {
      try {
        // start_session 是幂等的，也会在过期后 revive 同名会话。
        const started = await driver.callTool(
          "start_session",
          JSON.stringify({ session: agentCursor.session }),
        );
        if (started?.isError === true) {
          agentCursor.sessionUsable = false;
          agentCursor.enabled = false;
          agentCursor.lastError = started.errorCode ?? "start_session_failed";
          return;
        }
        agentCursor.sessionUsable = true;
        const enabled = await driver.callTool(
          "set_agent_cursor_enabled",
          JSON.stringify({ session: agentCursor.session, enabled: true }),
        );
        if (enabled?.isError === true) {
          agentCursor.enabled = false;
          agentCursor.lastError = enabled.errorCode ?? "cursor_failed";
          return;
        }
        // set 的返回只代表"请求被接受"；0.47.23 在 Windows 上可能仍是 enabled:false
        // （渲染层不工作）。以 get_agent_cursor_state 的实际状态为准，绝不伪造已启用。
        const state = await driver.callTool(
          "get_agent_cursor_state",
          JSON.stringify({ session: agentCursor.session }),
        );
        if (state?.isError === true) {
          agentCursor.enabled = false;
          agentCursor.lastError = state.errorCode ?? "cursor_state_unreadable";
          return;
        }
        const parsed = (() => {
          try {
            return JSON.parse(String(state?.structuredJson ?? "{}"));
          } catch {
            return {};
          }
        })();
        agentCursor.enabled = parsed.enabled === true;
        agentCursor.position = parsed.position ?? null;
        agentCursor.visualState = parsed.visual_state ?? parsed.visualState ?? null;
        agentCursor.lastError = undefined;
      } catch (error) {
        // 旧引擎/平台没有 cursor API 时，动作照常走 implicit session（fail-open 仅限可视化）。
        agentCursor.sessionUsable = false;
        agentCursor.enabled = false;
        agentCursor.lastError = error instanceof Error ? error.name : String(error);
      } finally {
        // 失败也写时间，避免每个动作都重试同一套 cosmetic 调用；4 分钟后再试。
        agentCursor.preparedAt = Date.now();
        agentCursorPrep = null;
      }
    })();
    return agentCursorPrep;
  };

  return {
    kind: "cua-driver",
    async metadata() {
      return await driver.metadata?.();
    },
    /** 供诊断/测试：不伪造 overlay 已启用——失败时 lastError 如实保留。 */
    agentCursorStatus() {
      return { ...agentCursor };
    },
    /**
     * 通用工具面：`callTool(name, args)`。用它而不是逐个 typed 方法，是因为上游的工具名与参数
     * 形状比 UniFFI 记录类型稳定得多（我们已把 57 个工具的 schema 打出来核对过：
     * click{action,button,count,element_token,x,y,window_id,scope,delivery_mode}、
     * drag{from_x,from_y,to_x,to_y}、type_text{text,...}、press_key{key,modifiers}、
     * scroll{direction,amount,by,...}、set_value{element_token,value}、
     * clipboard_read/clipboard_write、invoke_menu{path}）。
     */
    async callTool(name, args = {}) {
      let payload = args && typeof args === "object" ? args : {};
      if (CURSOR_INPUT_TOOLS.has(name)) {
        await prepareAgentCursor();
        // 同一会话的 cursor 动作才会驱动同一个 overlay；调用方显式给的 session 优先。
        if (agentCursor.sessionUsable && payload.session === undefined) {
          payload = { ...payload, session: agentCursor.session };
        }
      }
      const result = await driver.callTool(name, JSON.stringify(payload));
      const normalized = normalizeToolResult(name, result);
      // 会话过期后引擎会明确报 session 相关错误；下一次动作前重建（不重试本次动作）。
      if (
        typeof normalized.errorCode === "string" &&
        /session/i.test(normalized.errorCode)
      ) {
        agentCursor.sessionUsable = false;
        agentCursor.preparedAt = 0;
      }
      return normalized;
    },
    async listApps() {
      const output = await driver.listApps({});
      return { apps: output?.apps ?? [] };
    },
    async listWindows(params = {}) {
      const output = await driver.listWindows({
        ...(typeof params.pid === "number" ? { pid: params.pid } : {}),
        ...(typeof params.onScreenOnly === "boolean" ? { onScreenOnly: params.onScreenOnly } : {}),
      });
      return { windows: output?.windows ?? [] };
    },
    async getWindowState(params = {}) {
      // 截图/像素上下文是 session-owned：坐标点击必须与观察在同一个引擎会话里，
      // 否则引擎会报 screenshot_context_missing。会话建立失败时不带 session，退回隐式会话。
      await prepareAgentCursor();
      return await driver.getWindowState({
        ...params,
        ...(agentCursor.sessionUsable ? { session: agentCursor.session } : {}),
      });
    },
    async close() {
      try {
        await driver.shutdown?.();
      } catch {
        // 关不掉不影响上层：进程退出会带走原生线程。
      }
    },
  };
}

/**
 * 引擎结果 → 我们能用的形状。
 * ToolResult：`{text, images, structuredJson?, isError, errorCode?, degraded}`。
 * `structuredJson` 里的 BigInt 在 uniffi 侧会出现，序列化时按字符串保留（见 broker.js 同一坑）。
 */
export function normalizeToolResult(name, result) {
  const raw = result ?? {};
  const structured = (() => {
    if (typeof raw.structuredJson !== "string" || !raw.structuredJson.trim()) return undefined;
    try {
      return JSON.parse(raw.structuredJson);
    } catch {
      return undefined;
    }
  })();
  // 引擎怪癖（真机 2026-10-11 抓到）：**成功的后台按键**也带 isError:true，配
  // 「操作或完成。(0x00000000)」——0x00000000 是 HRESULT S_OK。不翻回来的话 assertEngineOk
  // 会把成功当拒绝，回执语义反向（动作明明生效却被报成 ACTION_REFUSED）。
  const sokReportedAsError =
    raw.isError === true &&
    (raw.errorCode === "0x00000000" || /\(0x0{8}\)/.test(String(raw.text ?? "")));
  return {
    tool: name,
    text: typeof raw.text === "string" ? raw.text : "",
    ...(structured ? { structured } : {}),
    ...(raw.isError === true && !sokReportedAsError ? { isError: true } : {}),
    ...(typeof raw.errorCode === "string" && raw.errorCode && !sokReportedAsError
      ? { errorCode: raw.errorCode }
      : {}),
    ...(sokReportedAsError ? { engineSokCorrected: true } : {}),
    ...(raw.degraded === true ? { degraded: true } : {}),
    ...(Array.isArray(raw.images) && raw.images.length > 0 ? { imageCount: raw.images.length } : {}),
  };
}
