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

  return {
    kind: "cua-driver",
    async metadata() {
      return await driver.metadata?.();
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
      const result = await driver.callTool(name, JSON.stringify(args));
      return normalizeToolResult(name, result);
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
      return await driver.getWindowState(params);
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
