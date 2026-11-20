/**
 * Computer Use 运行时（真实现）——宿主 `node-repl-host` 通过 `createComputerUseRuntime({brokerSocketPath})`
 * 拿到的就是它。职责：
 *   1. 会话内台账（元素索引 / 帧 / 观察基线 / 等待收敛）——见 ./session.js
 *   2. 工具分发与 MCP 信封组装——见 ./envelope.js
 *   3. 与 Helper 的传输（NDJSON over 命名管道 / Unix socket）——见 ../broker.js
 * 跨会话的租约与 kill switch 在 Helper 侧（单一进程仲裁）；这里只做会话内校验与等待策略。
 */

import { BrokerError, callBrokerMethod } from "../broker.js";
import { envelopeFromError, errorEnvelope, notReadyEnvelope, observationEnvelope, receiptEnvelope } from "./envelope.js";
import { INPUT_METHOD_NAMES, createSessionLedger } from "./session.js";
import { resolveActionTarget } from "./action-target.js";

const UNAVAILABLE_TEXT = "Computer Use is not available in this build.";
const SUBAGENT_MESSAGE = "Computer Use is not available in subagent";

/**
 * 锁屏与系统壳进程：它们的窗口**永远不该成为绑定目标**。
 * 真机事故（2026-10-11 用户实测）：按名绑定计算器时，launch 解析失败，而"唯一新窗口"
 * 兜底把锁屏窗口（LockApp.exe，元素树必然为空）当成了目标——随后透明激活在锁屏上白跑，
 * 模型再花两轮才自己绕回来。锁屏是会话级系统 UI，不是应用。
 */
const SYSTEM_SHELL_APP_PATTERN =
  /(^|[\/])(lockapp|windows\.lockapp|assignedaccesslockapp|shellexperiencehost|searchapp|startmenuexperiencehost|textinputhost)\.exe$|^microsoft\.lockapp|^microsoft\.windows\.assignedaccesslockapp|^microsoft\.windows\.shellexperiencehost|^microsoft\.windows\.search|^microsoft\.windows\.startmenuexperiencehost/i;

function isSystemShellApp(app) {
  const name = String(app?.name ?? "").trim();
  const bundle = String(app?.bundle_id ?? "").trim();
  if (name && SYSTEM_SHELL_APP_PATTERN.test(name)) return true;
  if (bundle && SYSTEM_SHELL_APP_PATTERN.test(bundle)) return true;
  // 窗口侧：标题为锁屏相关文案的也拒（中文系统标题是"Windows 默认锁屏界面"）。
  return false;
}

/** 窗口是否像锁屏/系统壳（用于窗口候选过滤）。 */
function isSystemShellWindowTitle(title) {
  return /默认锁屏|锁屏界面|lock screen|lockapp/i.test(String(title ?? ""));
}

/** 只读、直接透传的工具（观察类另外处理）。 */
const PASSTHROUGH_METHODS = new Set([
  "list_apps",
  "list_windows",
  "permission_status",
  "request_access",
  "stop_computer_control",
]);

export function createComputerUseRuntime(options = {}) {
  const socketPath = typeof options.brokerSocketPath === "string" ? options.brokerSocketPath.trim() : "";
  const env = options.env ?? process.env;
  const sessions = new Map();

  const ledgerOf = (context) => {
    const key = `${context?.sessionId ?? "anonymous"}`;
    if (!sessions.has(key)) sessions.set(key, createSessionLedger());
    return sessions.get(key);
  };

  const callHelper = async (method, params, timeoutMs) => {
    if (!socketPath) throw new BrokerError(UNAVAILABLE_TEXT, { code: "unavailable" });
    try {
      return await callBrokerMethod({ socketPath, method, params, ...(timeoutMs ? { timeoutMs } : {}) });
    } catch (error) {
      // 首次调用可能正赶上 Helper 懒启动：给宿主一次拉起机会，再原样重试一次。
      if (error instanceof BrokerError && typeof options.ensureBrokerAvailable === "function") {
        await options.ensureBrokerAvailable();
        return await callBrokerMethod({ socketPath, method, params, ...(timeoutMs ? { timeoutMs } : {}) });
      }
      throw error;
    }
  };

  /**
   * app_ref 解包（SDK shim 的绑定面只发 app_ref：{pid}/{window_id}/{name}/{bundle_id}，
   * 裸字符串按 bundle_id 语义——见 shim「工具层的 app_ref 把裸字符串一律当成 bundle_id」）。
   * 真机 2026-10-11：不认 app_ref 时绑定 API 的每次观察都被 unrecognized_keys 打回。
   */
  const unwrapAppRef = (value) => {
    if (typeof value === "string" && value.trim()) return { bundle_id: value.trim() };
    if (!value || typeof value !== "object") return {};
    const pid = typeof value.pid === "number" ? value.pid : undefined;
    const windowId = value.window_id ?? value.windowId;
    const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : undefined;
    const bundleId =
      typeof value.bundle_id === "string" && value.bundle_id.trim()
        ? value.bundle_id.trim()
        : undefined;
    return {
      ...(pid !== undefined ? { pid } : {}),
      ...(windowId !== undefined && windowId !== null ? { window_id: windowId } : {}),
      ...(name ? { name } : {}),
      ...(bundleId ? { bundle_id: bundleId } : {}),
    };
  };

  /** 观察：解析窗口（app_ref / window_id / pid / 名称）→ 调 Helper → 登记台账 → 抽出截图。 */
  const observe = async (context, params = {}) => {
    const ledger = ledgerOf(context);
    const appRef = unwrapAppRef(params.app_ref);
    let pid = typeof params.pid === "number" ? params.pid : appRef.pid;
    let windowId = params.window_id ?? params.windowId ?? appRef.window_id ?? null;
    // pid 0 = 注册表条目（应用没在跑），拿它过滤窗口必然 InvalidArguments。
    if (!windowId && typeof pid === "number" && pid > 0) {
      const listed = await callHelper("list_windows", { pid }, 10_000);
      const window = Array.isArray(listed?.windows) ? listed.windows[0] : undefined;
      windowId = window?.windowId ?? window?.window_id ?? null;
      if (!windowId) {
        throw Object.assign(new Error(`pid=${pid} 没有可见窗口`), { code: "ELEMENT_UNAVAILABLE" });
      }
    }
    if (!windowId && !pid && (appRef.name || appRef.bundle_id)) {
      // 按名/包名解析：包含匹配（"计算器" ⊂ "Windows 计算器"——用户嘴里的名字几乎总是
      // 应用名的子串，精确等值真机匹配不到）。**优先运行中的条目**；list_apps 里同一应用
      // 常有两条（运行中的 exe 条目 + 注册表条目 pid=0/running:false），命中注册条目时
      // 走**透明拉起**（上游 open_application 已并入 get_app_state 的同款职责）：
      // launch_app → 按标题在全窗口里找 → pid+window_id。没有 launch 会把"打错名字"变成
      // "凭空开应用"，但命中注册条目说明用户确实指名了这个应用。
      const wanted = appRef.name ?? appRef.bundle_id;
      const wantedLower = wanted.toLowerCase();
      const apps = await callHelper("list_apps", {}, 10_000);
      const all = Array.isArray(apps?.apps) ? apps.apps : [];
      const matches = (app) => {
        const appName = String(appRef.name ? (app.name ?? "") : (app.bundle_id ?? ""));
        if (!appName) return false;
        const appLower = appName.toLowerCase();
        return appRef.name
          ? appLower.includes(wantedLower) || wantedLower.includes(appLower)
          : appName === appRef.bundle_id;
      };
      const isRunning = (app) => app.running !== false && typeof app.pid === "number" && app.pid > 0;
      let found = all.find((app) => isRunning(app) && matches(app) && !isSystemShellApp(app));
      if (!found) {
        const registryHit = all.find((app) => matches(app) && !isSystemShellApp(app));
        if (registryHit) {
          // 先看"是不是已经开着"：UWP 应用运行时，list_apps 里**可能只剩注册条目**
          // （pid=0/running:false，真机实测 2026-10-11）——此时真窗口已存在于窗口列表，
          // 直接按标题找即可，拉起只会在已开的情况下白跑一趟（甚至多开一个窗口）。
          const existing = await callHelper("list_windows", {}, 10_000);
          // 双向包含：窗口标题常是短名（"计算器"）而注册名是长名（"Windows 计算器"）——
          // 只判 wanted ⊂ title 会漏（真机实测："计算器".includes("windows 计算器") = false）。
          const titleMatches = (title) => {
            const t = String(title ?? "").toLowerCase();
            if (!t) return false;
            if (t.includes(wantedLower) || wantedLower.includes(t)) return true;
            const registryName = String(registryHit.name ?? "").toLowerCase();
            return Boolean(registryName) && (t.includes(registryName) || registryName.includes(t));
          };
          const titleCandidates = (Array.isArray(existing?.windows) ? existing.windows : []).filter(
            (window) =>
              !isSystemShellWindowTitle(window.title) &&
              (titleMatches(window.title) || titleMatches(window.app_name ?? window.appName)),
          );
          // 标题可能有多个候选，两个真机事实叠加：
          // ① 陈旧锁屏窗口标题也匹配"计算器"，元素树恒为空 → 必须挑**有元素**的；
          // ② 同名窗口可能同时在（真机 2026-10-12：桌面上两个计算器窗口，绑到非前台那个后
          //    foreground 交付被前台校验拒绝"目标窗口不在前台"，模型只能自己重绑）。
          // 引擎的 window 列表没有 focused 字段，但有 **z_index**（前台窗口最高）——
          // 按 z_index 降序排，优先绑最靠前的那个。
          const ordered = [...titleCandidates].sort((a, b) => {
            const za = Number(a?.z_index ?? a?.zIndex ?? 0);
            const zb = Number(b?.z_index ?? b?.zIndex ?? 0);
            return (Number.isFinite(zb) ? zb : 0) - (Number.isFinite(za) ? za : 0);
          });
          for (const candidate of ordered) {
            const candidatePid = Number(candidate.pid);
            const candidateWid = candidate.windowId ?? candidate.window_id;
            if (!(Number.isFinite(candidatePid) && candidatePid > 0 && candidateWid !== undefined)) continue;
            try {
              const probe = await callHelper(
                "get_app_state",
                { window_id: String(candidateWid), pid: candidatePid, force_full: true },
                15_000,
              );
              const probeElements = Array.isArray(probe?.elements) ? probe.elements : [];
              if (probeElements.length > 0) {
                pid = candidatePid;
                windowId = String(candidateWid);
                break;
              }
            } catch {
              // 该候选读不出（已消失/无权限）：试下一个。
            }
          }
        }
        if (!windowId && registryHit) {
          // UWP 跨 pid 绑定（真机 2026-10-11）：packaged 应用由 ApplicationFrameHost 承载——
          // 注册条目 pid=0、运行态条目是 AFH 的 pid，而**真窗口**挂在 AFH 名下且标题与应用名
          // 不一致（"计算器"）。所以拉起后不能按 pid 找窗口，要**按窗口增量**找：
          // 记下启动前的窗口 id 集合，出现的新窗口即目标。
          const beforeWindows = await callHelper("list_windows", {}, 10_000);
          const beforeIds = new Set(
            (Array.isArray(beforeWindows?.windows) ? beforeWindows.windows : []).map((w) =>
              String(w.windowId ?? w.window_id),
            ),
          );
          // 依次尝试：用户的叫法（真机实证 "计算器" 能被 shell 解析）、注册条目名、launch_path、aumid。
          const launchAttempts = [
            ...new Set([appRef.name, registryHit.name].filter((n) => typeof n === "string" && n.trim())).values(),
          ].map((name) => ({ name }));
          if (typeof registryHit.launch_path === "string" && registryHit.launch_path.trim()) {
            launchAttempts.push({ launch_path: registryHit.launch_path.trim() });
          }
          if (typeof registryHit.aumid === "string" && registryHit.aumid.trim()) {
            launchAttempts.push({ aumid: registryHit.aumid.trim() });
          }
          // 默认后台拉起（helper 不激活）；只有调用方显式 activate:true 才允许前台化。
          const launchOptions = {
            ...(params.activate === true ? { activate: true } : {}),
            ...(typeof params.start_minimized === "boolean"
              ? { start_minimized: params.start_minimized }
              : {}),
          };
          let launched = false;
          for (const attempt of launchAttempts) {
            try {
              const r = await callHelper("launch_app", { ...attempt, ...launchOptions }, 30_000);
              if (r?.launched !== false) {
                launched = true;
                break;
              }
            } catch {
              // 该方式失败：试下一个。
            }
          }
          // 轮询窗口增量（UWP 冷启动实测 ~1.2s 内出现；给 8s 上限）。
          for (let attempt = 0; attempt < 8 && !windowId; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const windows = await callHelper("list_windows", {}, 10_000);
            const all_windows = Array.isArray(windows?.windows) ? windows.windows : [];
            const fresh = all_windows.filter(
              (w) => !beforeIds.has(String(w.windowId ?? w.window_id)),
            );
            // 必须有**标题证据**才采纳：真机事故（2026-10-11）里"唯一新窗口"兜底把锁屏
            // 当成了目标——宁可这一轮找不到（交给下面的兜底/报错），也不绑错应用。
            const usable = fresh.filter((w) => !isSystemShellWindowTitle(w.title));
            const candidate = usable.find((w) => {
              const t = String(w.title ?? "").toLowerCase();
              const registryName = String(registryHit.name ?? "").toLowerCase();
              return (
                t.includes(wantedLower) ||
                wantedLower.includes(t) ||
                (Boolean(registryName) && (t.includes(registryName) || registryName.includes(t)))
              );
            });
            if (candidate) {
              const candidatePid = Number(candidate.pid);
              const candidateWid = candidate.windowId ?? candidate.window_id;
              if (Number.isFinite(candidatePid) && candidatePid > 0 && candidateWid !== undefined) {
                pid = candidatePid;
                windowId = String(candidateWid);
              }
            }
          }
          // 兜底：应用此前已在运行时不会有"新窗口"，按标题在既有窗口里找。
          if (!windowId) {
            const windows = await callHelper("list_windows", {}, 10_000);
            const candidate = (Array.isArray(windows?.windows) ? windows.windows : []).find(
              (window) =>
                !isSystemShellWindowTitle(window.title) &&
                String(window.title ?? "").toLowerCase().includes(wantedLower),
            );
            if (candidate) {
              const candidatePid = Number(candidate.pid);
              const candidateWid = candidate.windowId ?? candidate.window_id;
              if (Number.isFinite(candidatePid) && candidatePid > 0 && candidateWid !== undefined) {
                pid = candidatePid;
                windowId = String(candidateWid);
              }
            }
          }
        }
      }
      if (!windowId && found && isRunning(found)) {
        pid = found.pid;
      }
      if (!windowId && typeof pid === "number" && pid > 0) {
        const listed = await callHelper("list_windows", { pid }, 10_000);
        const window = Array.isArray(listed?.windows) ? listed.windows[0] : undefined;
        windowId = window?.windowId ?? window?.window_id ?? null;
        if (!windowId) {
          throw Object.assign(new Error(`「${wanted}」在运行但没有可见窗口`), {
            code: "ELEMENT_UNAVAILABLE",
          });
        }
      }
      if (!windowId) {
        throw Object.assign(
          new Error(`app_ref「${wanted}」没有匹配到运行中的应用；用 list_apps 核对名称`),
          { code: "APP_NOT_FOUND" },
        );
      }
    }
    if (!windowId) {
      windowId = ledger.lastWindowId;
    }
    if (!windowId) {
      throw Object.assign(new Error("观察需要 window_id 或 pid"), { code: "unrecognized_keys" });
    }
    const includeScreenshot = params.include_screenshot === true;
    const receipt = await callHelper(
      "get_app_state",
      {
        window_id: String(windowId),
        ...(typeof pid === "number" ? { pid } : {}),
        ...(includeScreenshot ? { include_screenshot: true } : {}),
        // 观察默认不激活窗口；只有调用方显式要求才把 activate 透传给 Helper 的透明激活级联。
        ...(params.activate === true ? { activate: true } : {}),
      },
      30_000,
    );
    // 截图本体只在 MCP content 的 image 块走一次；收据（树文本块 + structuredContent 两处）
    // 不带 base64，否则同一张图要翻三倍。
    const screenshot = receipt?.screenshot;
    const clean = { ...receipt };
    delete clean.screenshot;
    ledger.registerObservation(clean, { includeScreenshot });
    return { receipt: clean, screenshot };
  };

  // 动作目标解析（target 解包 + 新鲜台账绑定）见 ./action-target.js。

  const execute = async (input) => {
    const toolName = input?.toolName;
    const params = input?.arguments && typeof input.arguments === "object" ? input.arguments : {};
    const context = input?.context ?? {};
    try {
      if (!socketPath) return errorEnvelope("helper_unavailable", UNAVAILABLE_TEXT);
      if (context.runtimeScope === "subagent") {
        return errorEnvelope("SUBAGENT_NOT_ALLOWED", SUBAGENT_MESSAGE);
      }
      const ledger = ledgerOf(context);

      if (toolName === "get_app_state") {
        const { receipt, screenshot } = await observe(context, params);
        // image_ref 四键固定文本块（规格 §3.2）：带截图时必须另发一块，SDK 靠它绑坐标动作。
        const frame = ledger.frames().at(-1);
        const imageRef =
          params.include_screenshot === true && frame
            ? {
                frame_id: frame.frameId,
                width: frame.width ?? null,
                height: frame.height ?? null,
                actionable: true,
                note:
                  "坐标动作的 x/y 用截图像素坐标（与元素 screenshot_frame 同一空间）；" +
                  "元素动作请用 elements 里的 index；元素 frame 字段是屏幕坐标，别混用",
              }
            : null;
        return observationEnvelope(receipt, imageRef, screenshot);
      }
      if (toolName === "get_app_state" || toolName === "disable_diffing") {
        // disable_diffing 由 SDK 传在 get_app_state 的 args 里；单独的方法名不接受（占位防误用）。
      }
      if (PASSTHROUGH_METHODS.has(toolName)) {
        const result = await callHelper(toolName, { ...params, session_id: context.sessionId ?? null });
        return receiptEnvelope(result ?? {});
      }
      if (INPUT_METHOD_NAMES.has(toolName)) {
        const target = resolveActionTarget(ledger, params);
        // perform_action 只认元素**广告过**的动作（规格：禁止猜测）——菜单路径（含 ">"）除外。
        if (toolName === "perform_action") {
          const action = String(params.action ?? "");
          if (!/[>›»]|->/.test(action)) {
            // 真机事故（2026-10-12，模型自己排查出来）：该校验块跑在 resolveTarget **之前**，
            // 却直接读顶层 params.element_index —— 而绑定面 SDK 发的是 `target:{type:"element",
            // index}`，于是校验永远找不到元素、报"需要元素 index"，模型只能绕到底层
            // computer.perform_action({element_index}) 才能点按键。这里先在同一处解包 target。
            const targetIndex = (() => {
              const direct = params.element_index ?? params.elementIndex;
              if (direct !== undefined) return direct;
              const t = params.target;
              if (typeof t === "number") return t;
              if (t && typeof t === "object") return t.element_index ?? t.elementIndex ?? t.index;
              return undefined;
            })();
            const element = ledger.shown?.elements?.find((item) => item.index === targetIndex);
            const advertised = Array.isArray(element?.actions) ? element.actions : [];
            if (!element) {
              throw Object.assign(
                new Error("perform_action 需要元素 index（或给「菜单 > 项」这样的路径）"),
                { code: "STALE_STATE" },
              );
            }
            if (!advertised.includes(action)) {
              throw Object.assign(
                new Error(
                  `元素 index=${element.index} 没有广告动作「${action}」；它广告的是 [${advertised.join(" ")}]`,
                ),
                { code: "ACTION_UNAVAILABLE", details: { actions: advertised } },
              );
            }
          }
        }
        // 引擎的动作工具大多要 pid + window_id；台账里记住的窗口身份一并带上（缺了会 InvalidArguments）。
        if (target.window_id === undefined && ledger.lastWindowId) target.window_id = ledger.lastWindowId;
        if (target.pid === undefined && ledger.lastPid !== null) target.pid = ledger.lastPid;
        const baselineStateId = ledger.shown?.stateId ?? null;
        const receipt = await callHelper(
          toolName,
          { ...target, session_id: context.sessionId ?? null },
          60_000,
        );
        // possibly_sent：不重试、不等待，直接把回执交给 SDK（它会转成 actionSent 错误）。
        if (receipt?.dispatch_status === "possibly_sent") {
          return receiptEnvelope({
            ...receipt,
            state_sync_status: "unknown",
            ...(baselineStateId ? { base_state_id: baselineStateId } : {}),
          });
        }
        const settle = await ledger
          .settleAfterAction((windowId) =>
            observe(context, { window_id: windowId }).then((observed) => observed.receipt),
          )
          .catch(() => ({ settled: false, samples: 0, effectEvidence: "unknown" }));
        // 后台交付 + 界面无变化：该应用可能只响应前台输入（WinUI/UWP 挂起时 UIA Invoke
        // 空转，真机 2026-10-11 实证）。**不自动重试**（点击落地与否不确定，重放可能双触发），
        // 把确切的补救写进回执，由模型决定是否置前重试。
        const needsForegroundHint =
          receipt?.delivery_mode === "background" && settle.effectEvidence === "unchanged";
        const escalationNote = needsForegroundHint
          ? "\n[effect-unchanged] 后台交付已派发但界面无变化——该应用可能只响应前台输入；" +
            "若此动作可安全重复，可显式带 delivery_mode:\"foreground\" 重试（会把窗口带到前台）"
          : "";
        const baseReceipt = {
          ...receipt,
          action_sent: receipt?.action_sent !== false,
          dispatch_status: receipt?.dispatch_status ?? "sent",
          state_sync_status: settle.settled ? "settled" : "timeout",
          effect_evidence: settle.effectEvidence,
          ...(baselineStateId ? { base_state_id: baselineStateId } : {}),
          ...(settle.receipt?.state_id ? { state_id: settle.receipt.state_id } : {}),
        };
        if (escalationNote) baseReceipt.text = `${baseReceipt.text ?? ""}${escalationNote}`;
        return receiptEnvelope(baseReceipt);
      }
      return errorEnvelope("INTERNAL", `未知的工具：${String(toolName)}`);
    } catch (error) {
      const code = typeof error?.code === "string" ? error.code : "INTERNAL";
      if (code === "unavailable" || code === "timeout") {
        // 传输层没通 = Helper 可能正在冷启动：给可重试的 not-ready 信封，绝不冒充动作失败。
        return notReadyEnvelope(code === "timeout" ? "broker_timeout" : "broker_not_accepting");
      }
      return envelopeFromError(error);
    }
  };

  const closeSession = async (context) => {
    const key = `${context?.sessionId ?? "anonymous"}`;
    sessions.delete(key);
    if (!socketPath) return;
    try {
      await callHelper("release_input_lease", { session_id: context?.sessionId ?? null }, 5000);
    } catch {
      // 释放失败不该影响会话收尾：Helper 侧还有 kill switch 与进程退出兜底。
    }
  };

  const dispose = async () => {
    sessions.clear();
  };

  return { execute, closeSession, dispose, ...(env === undefined ? {} : {}) };
}
