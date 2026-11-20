/**
 * 会话内台账（**运行时侧**语义）：元素索引、帧、观察基线、等待收敛。
 *
 * 与 Helper 的分工：Helper 管跨会话的租约与总闸；这里是**每个 node_repl 宿主进程**里、
 * 按会话隔离的记账。上游同形（"宿主工具层：AccessibilitySession / FrameRegistry /
 * ActionSettler"），语义见 vendor/freeall12-computer-use/docs/zcode-computer-use.md §4/§5。
 */

const MAX_FRAMES = 16;
const MAX_TOMBSTONES = 32;
const SETTLE_START_MS = 300;
const SETTLE_CAP_MS = 5000;
const SETTLE_POLL_MS = 200;

const INPUT_METHODS = new Set([
  "left_click",
  "left_click_drag",
  "scroll",
  "type",
  "key",
  "paste",
  "set_value",
  "select_text",
  "perform_action",
]);

export function isInputMethod(method) {
  return INPUT_METHODS.has(method);
}

/** 同一个集合的只读视图：运行时用它判"这是不是动作类工具"。 */
export const INPUT_METHOD_NAMES = INPUT_METHODS;

function fingerprint(receipt) {
  const elements = Array.isArray(receipt?.elements) ? receipt.elements : [];
  return elements
    .map((element) => `${element.index}|${element.kind}|${element.name}|${element.value ?? ""}`)
    .join("\n");
}

export function createSessionLedger(options = {}) {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const maxFrames = options.maxFrames ?? MAX_FRAMES;
  const maxTombstones = options.maxTombstones ?? MAX_TOMBSTONES;
  const settleStartMs = options.settleStartMs ?? SETTLE_START_MS;
  const settleCapMs = options.settleCapMs ?? SETTLE_CAP_MS;

  /** 最近一次**给模型看过**的观察（双基线里的"模型见过"那一条）。 */
  let shown = null;
  /** 给模型看过的上一次指纹，用于 effect_evidence。 */
  let shownFingerprint = null;
  const frames = [];
  const tombstones = [];
  /** 上一次动作后的观察（Helper 侧还有一份"数据变没变"的基线，两边各管一件事）。 */
  let lastWindowId = null;
  let lastPid = null;
  /**
   * possibly_sent 之后必须让下一次观察是**整树**（规格 §6.3）。我们目前**所有观察都返回整树**
   * （有意：错的 diff 比全量更危险），所以这里只做记账，等将来实现 diff 时它就是开关。
   */
  let forceFullTreeNext = false;

  function fail(code, message, details) {
    const error = new Error(message);
    error.code = code;
    if (details !== undefined) error.details = details;
    error.actionSent = false;
    return error;
  }

  return {
    get shown() {
      return shown;
    },
    get lastWindowId() {
      return lastWindowId;
    },
    get lastPid() {
      return lastPid;
    },
    get forceFullTreeNext() {
      return forceFullTreeNext;
    },
    /** 收到 possibly_sent 回执时调用：下一次观察必须整树。 */
    markPossiblySent() {
      forceFullTreeNext = true;
    },
    frames() {
      return [...frames];
    },
    tombstones() {
      return [...tombstones];
    },

    /** 登记一次观察：铸帧（若带截图）、刷新元素索引台账、更新"模型见过"的基线。 */
    registerObservation(receipt, { includeScreenshot = false } = {}) {
      if (!receipt || typeof receipt.state_id !== "string") {
        throw fail("STRUCTURED_STATE_UNAVAILABLE", "观察收据缺 state_id");
      }
      if (!Array.isArray(receipt.elements)) {
        throw fail("STRUCTURED_STATE_UNAVAILABLE", "观察收据缺 elements");
      }
      const previous = shown;
      shown = {
        stateId: receipt.state_id,
        elements: receipt.elements,
        window: receipt.window ?? previous?.window,
        fingerprint: fingerprint(receipt),
        at: now(),
      };
      if (typeof receipt.window?.window_id === "string") lastWindowId = receipt.window.window_id;
      else if (typeof receipt.window?.window_id === "number") lastWindowId = String(receipt.window.window_id);
      if (typeof receipt.window?.pid === "number") lastPid = receipt.window.pid;
      shownFingerprint = previous?.fingerprint ?? null;

      forceFullTreeNext = false; // 观察过一次（整树）就清掉标记
      const frameId = receipt.frame_id ?? receipt.frameId;
      if (includeScreenshot && typeof frameId === "string" && frameId) {
        frames.push({
          frameId,
          stateId: receipt.state_id,
          at: now(),
          // 宽高来自引擎的 screenshotWidth/Height（image_ref 四键要用）——缺就留 null，别编。
          ...(typeof receipt.screenshot_width === "number" ? { width: receipt.screenshot_width } : {}),
          ...(typeof receipt.screenshot_height === "number" ? { height: receipt.screenshot_height } : {}),
        });
        while (frames.length > maxFrames) {
          const dropped = frames.shift();
          tombstones.push(dropped);
          while (tombstones.length > maxTombstones) tombstones.shift();
        }
      }
      return shown;
    },

    /** 元素索引必须来自最近一次"模型见过"的观察；没有观察 → STALE_STATE，索引不在台账 → ELEMENT_UNAVAILABLE。 */
    resolveElement(index) {
      if (!shown) {
        throw fail("STALE_STATE", "还没有观察过：先 get_app_state 再按返回的 index 操作");
      }
      const element = shown.elements.find((item) => item.index === index);
      if (!element) {
        throw fail(
          "ELEMENT_UNAVAILABLE",
          `元素 index=${index} 不在最近一次观察里（元素可能已消失）；重新观察后再决定`,
        );
      }
      return element;
    },

    /** 坐标动作必须绑一个新鲜可动作的帧：没有帧 / 帧过期或被替换 → action_sent=false。 */
    assertFrame(frameId) {
      if (!frames.some((frame) => frame.frameId === frameId)) {
        const tombstoned = tombstones.some((frame) => frame.frameId === frameId);
        throw fail(
          "STALE_STATE",
          tombstoned
            ? `帧 ${frameId} 已被替换（帧台账只留最近 ${maxFrames} 帧）；重新观察取新帧`
            : `帧 ${frameId} 不在台账里；坐标动作只能绑最近观察到的帧`,
          { frame_id: frameId },
        );
      }
    },

    assertHasActionableFrame() {
      if (frames.length === 0) {
        throw fail(
          "STALE_STATE",
          "no actionable frame is available in this transport；先带 include_screenshot 观察一次",
        );
      }
      return frames[frames.length - 1].frameId;
    },

    /**
     * 动作后等待界面收敛：300ms 起步，树指纹连续两次一致即返回，撞 5s 上限也返回
     * （上游：ActionSettler）。返回 `{ settled, samples, effectEvidence }`。
     */
    async settleAfterAction(observe, { expectedWindowId } = {}) {
      await sleep(settleStartMs);
      const startedAt = now();
      let previous = null;
      let stableHits = 0;
      let samples = 0;
      let latest = null;
      while (now() - startedAt < settleCapMs) {
        const receipt = await observe(expectedWindowId ?? lastWindowId);
        samples += 1;
        const current = fingerprint(receipt);
        if (previous !== null && current === previous) stableHits += 1;
        else stableHits = 0;
        previous = current;
        latest = receipt;
        if (stableHits >= 1) {
          const effectEvidence = current === shownFingerprint ? "unchanged" : "changed";
          return { settled: true, samples, effectEvidence, receipt: latest };
        }
        await sleep(SETTLE_POLL_MS);
      }
      const current = previous ?? "";
      return {
        settled: false,
        samples,
        effectEvidence: current === shownFingerprint ? "unchanged" : "changed",
        receipt: latest,
      };
    },
  };
}

/** 供测试与文档引用：把常量暴露出来，免得两边各写一份。 */
export const LEDGER_LIMITS = Object.freeze({
  MAX_FRAMES,
  MAX_TOMBSTONES,
  SETTLE_START_MS,
  SETTLE_CAP_MS,
});
