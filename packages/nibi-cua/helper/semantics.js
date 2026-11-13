/**
 * Helper 侧语义（**权威**）：租约、kill switch、观察收据、动作结果形状。
 *
 * 为什么放 Helper 而不是运行时：这些是**跨会话**的互斥/总闸，只有单一进程能仲裁；
 * 运行时（每个 node_repl 宿主一个）只管会话内的元素/帧台账与等待策略。
 * 上游把租约/kill switch 记在"宿主工具层"（见厂商文档 §6.3/§6.4）——我们是同一个职责的
 * 另一种切分，行为语义保持一致：CONTROLLER_BUSY 永不重试、kill switch 闩锁后 fail-hard、
 * 两处豁免（request_access 与 stop_computer_control 自身）。
 */

/** @typedef {{sessionId: string|null, at: number}} Lease */

/**
 * 租约空闲超时（毫秒）。**必须有过期**：真机事故（2026-10-11）——一个调试/异常退出的会话
 * 留下租约，把用户后续所有操控都挡在 CONTROLLER_BUSY 之外，且没有任何自动恢复路径，
 * 用户只能眼看任务失败。输入租约是"谁在操作"的互斥，语义上是**活跃期**占用，
 * 不是永久所有权：超过空闲时间没有新动作就自动失效，让下个会话接管。
 * 取 90s：远大于单次动作间隔（点击/键入通常秒级），又远小于"用户等不下去"的时长。
 */
const DEFAULT_LEASE_IDLE_MS = 90_000;

export function createHelperSemantics(options = {}) {
  const now = options.now ?? (() => Date.now());
  const leaseIdleMs =
    typeof options.leaseIdleMs === "number" && options.leaseIdleMs > 0
      ? options.leaseIdleMs
      : DEFAULT_LEASE_IDLE_MS;
  /** @type {Lease|null} 当前持有输入权的会话 */
  let lease = null;

  /** 租约是否已空闲过期（过期即清空并返回 true，调用方按"无租约"处理）。 */
  const expireIdleLease = () => {
    if (!lease) return false;
    if (now() - lease.at <= leaseIdleMs) return false;
    lease = null;
    return true;
  };
  let killSwitchLatched = false;
  let observationSeq = 0;

  const exemptFromKillSwitch = new Set(["request_access", "stop_computer_control"]);

  return {
    status() {
      expireIdleLease();
      return { lease, killSwitchLatched };
    },
    /** kill switch 闩锁后：所有工具入口 fail-hard，两处豁免。 */
    assertKillSwitchAllows(method) {
      if (killSwitchLatched && !exemptFromKillSwitch.has(method)) {
        throw Object.assign(new Error("Computer Use 已被 stop_computer_control 停止；需用户重新授权后再用"), {
          code: "CONTROL_STOPPED",
        });
      }
    },
    /** 输入类动作的**跨会话**互斥：不同会话要输入时 CONTROLLER_BUSY（永不重试）。 */
    acquireInputLease(method, sessionId) {
      expireIdleLease();
      const owner = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
      if (lease && owner && lease.sessionId && lease.sessionId !== owner) {
        throw Object.assign(new Error(`输入正在被另一个会话占用：${lease.sessionId}`), {
          code: "CONTROLLER_BUSY",
          details: { owner: lease.sessionId },
        });
      }
      if (owner) lease = { sessionId: owner, at: now() };
      return owner;
    },
    releaseInputLease() {
      lease = null;
    },
    /**
     * **强制**释放租约（不看持有者）。给宿主用：宿主的 turn 生命周期是"这次操控真的结束了"
     * 的权威信号，而租约持有者（会话）未必会主动释放（真机 2026-10-12：会话 A 算出 42 后
     * 租约仍挂着，会话 B 被 CONTROLLER_BUSY 挡住、要用户手动关会话）。
     * 与 releaseInputLease（模型可调、要求持有者匹配）分开：这是可信侧的收口入口。
     */
    forceReleaseInputLease() {
      const previous = lease?.sessionId ?? null;
      lease = null;
      return previous;
    },
    latchKillSwitch() {
      killSwitchLatched = true;
      lease = null;
    },
    /** 每次观察铸造一个新的 state_id（运行时用它做"元素索引是否还新鲜"的凭证）。 */
    mintStateId() {
      observationSeq += 1;
      return `st-${Date.now().toString(36)}-${observationSeq.toString(36)}`;
    },
  };
}

/** 输入工具集合（需要租约 + kill switch 检查）。 */
export const INPUT_METHODS = Object.freeze([
  "left_click",
  "left_click_drag",
  "scroll",
  "type",
  "set_value",
  "select_text",
  "key",
  "paste",
  "perform_action",
]);

/** 把引擎的窗口状态规范成模型可见的观察收据（字段名与上游一致）。 */
export function normalizeObservation(raw, stateId) {
  const elements = [];
  const source = Array.isArray(raw?.elements) ? raw.elements : [];
  source.forEach((element, index) => {
    // 引擎（cua-driver）的字段名：role / label / elementToken / frame{x,y,w,h} / value / actions。
    // 少了 elementToken 就没法做目标寻址（set_value/click 都要它）——实测踩过：只认 token/name
    // 的规范化把这些全丢掉，动作只能退化成坐标点击。
    const token = element?.elementToken ?? element?.token ?? element?.element_token ?? element?.id;
    const frame = element?.frame;
    // 引擎还给 screenshot_frame（元素在**截图位图**里的坐标）——模型看到的是截图，
    // 按"它在图里看到的位置"点按最不容易错（真机 2026-10-11：模型自己换算屏幕坐标
    // 换错了两轮）。frame 是屏幕坐标、screenshot_frame 是位图坐标，两个都给并注明。
    const shotFrame = element?.screenshot_frame ?? element?.screenshotFrame;
    elements.push({
      index: index + 1,
      ...(token === undefined || token === null || token === "" ? {} : { token: String(token) }),
      kind: element?.role ?? element?.kind ?? "unknown",
      name: element?.label ?? element?.name ?? element?.title ?? "",
      ...(element?.value === undefined || element.value === "" ? {} : { value: element.value }),
      ...(typeof element?.valueDescription === "string" && element.valueDescription
        ? { value_description: element.valueDescription }
        : {}),
      ...(element?.editable === true ||
      (Array.isArray(element?.actions) && element.actions.includes("set_value"))
        ? { editable: true }
        : {}),
      ...(element?.focused ? { focused: true } : {}),
      ...(element?.enabled === false ? { enabled: false } : {}),
      ...(element?.selected === true ? { selected: true } : {}),
      ...(frame && typeof frame === "object"
        ? { frame: { x: frame.x, y: frame.y, w: frame.w, h: frame.h } }
        : {}),
      ...(shotFrame && typeof shotFrame === "object"
        ? { screenshot_frame: { x: shotFrame.x, y: shotFrame.y, w: shotFrame.w, h: shotFrame.h } }
        : {}),
      ...(Array.isArray(element?.actions) && element.actions.length > 0
        ? { actions: element.actions }
        : {}),
    });
  });
  const text =
    typeof raw?.text === "string" && raw.text.trim()
      ? raw.text
      : renderTreeText(elements);
  // 真引擎给的是 snapshotId（快照号）；fake/上游契约叫 frame_id —— 同一个"帧权威"，统一成 frame_id
  // （坐标动作绑帧、image_ref 四键都靠它；丢了帧就等于坐标动作全废，实测踩过）。
  const frameId = raw?.frame_id ?? raw?.frameId ?? raw?.snapshotId ?? raw?.snapshot_id;
  const shotWidth = raw?.screenshotWidth ?? raw?.screenshot_width;
  const shotHeight = raw?.screenshotHeight ?? raw?.screenshot_height;
  // SDK shim 的绑定面要求观察回执必须带 `app` 与 `window`（缺哪个都抛
  // STRUCTURED_STATE_UNAVAILABLE —— 真机 2026-10-11 实测缺的就是 app）。真引擎的字段是 appName。
  const appName = raw?.appName ?? raw?.app_name;
  return {
    state_id: stateId,
    ...(appName || typeof raw?.pid === "number"
      ? {
          app: {
            ...(typeof appName === "string" && appName ? { name: appName } : {}),
            ...(typeof raw?.pid === "number" ? { pid: raw.pid } : {}),
          },
        }
      : {}),
    // 帧号必须透传：坐标动作要绑新鲜帧（台账只认它），丢了帧就等于坐标动作全废（实测踩过）。
    ...(typeof frameId === "string" && frameId ? { frame_id: frameId } : {}),
    ...(typeof shotWidth === "number" ? { screenshot_width: shotWidth } : {}),
    ...(typeof shotHeight === "number" ? { screenshot_height: shotHeight } : {}),
    ...(raw?.image_ref ? { image_ref: raw.image_ref } : {}),
    ...(raw?.app ? { app: raw.app } : {}),
    // 引擎的多数动作工具都要求 pid + window_id 一起给（缺 pid = Missing required integer field pid，
    // 实测踩过）。观察时就把它记住，后面所有动作都带上。
    ...(raw?.window
      ? { window: raw.window }
      : raw?.windowId
        ? {
            window: {
              window_id: String(raw.windowId),
              ...(typeof raw.pid === "number" ? { pid: raw.pid } : {}),
              ...(raw.title === undefined ? {} : { title: raw.title }),
            },
          }
        : {}),
    elements,
    text,
  };
}

/** 元素是否可写：引擎给 editable，或 actions 里广告了 set_value。 */
export function isEditableElement(element) {
  return element?.editable === true || (Array.isArray(element?.actions) && element.actions.includes("set_value"));
}

export function renderTreeText(elements) {
  return elements
    .map((element) => {
      const parts = [String(element.index), element.kind, element.name];
      if (element.value !== undefined) parts.push(`value=${JSON.stringify(element.value)}`);
      if (element.editable) parts.push("editable");
      if (element.focused) parts.push("focused");
      if (element.actions) parts.push(`actions=[${element.actions.join(" ")}]`);
      return parts.join("  ");
    })
    .join("\n");
}
