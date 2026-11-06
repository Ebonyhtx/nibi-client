/**
 * NIBI 自己的渲染层持久化键空间。
 *
 * ## 为什么要有这一层
 *
 * NIBI 与上游 ZCode 可能装在同一台机器、甚至同一个 origin 上，`zcode-*` / `zai*` 这些键
 * 就是**另一个产品的数据**。运营者定的规则是：除插件兼容外，绝不与上游有任何数据关联。
 * 只靠"写代码时记得别读"守不住——迟早有人为了兼容或图省事加一条回退。
 *
 * 所以这里对键前缀做**白名单**：不在 `nibi:` / `nibi-` 下的键，读返回 `null`、写不生效，
 * 并记一条诊断（`nibiStorageDiagnostics()`）让人看得见，而不是静默。
 * 这样跨产品读取没有代码路径，迁移也只可能发生在 NIBI 自己的键之间。
 *
 * ## 两种键
 *
 * - `nibi:` —— 结构化偏好，值是 JSON，带 `version`（见 {@link NIBI_PREFS_KEY}）。
 * - `nibi-` —— 单值偏好，值是裸字符串，结构不会演进。
 *
 * 需要迁移时（字段改名、语义变化）用 `nibi:` 带 version；纯增量加字段**不动版本号**。
 * 已发布的键名一律冻结，见 `docs/adr/`。
 */

/** 允许的键前缀。加新的结构化键用 `nibi:`，加单值键用 `nibi-`。 */
export const NIBI_KEY_PREFIXES = ["nibi:", "nibi-"] as const;

/** 渲染层结构化偏好的键（主题、动效、界面语言）。 */
export const NIBI_PREFS_KEY = "nibi:prefs";

/**
 * 偏好结构的当前版本。
 *
 * 只在**破坏性**改动时 +1（字段改名、语义变化、值域收窄），并在 {@link migratePrefs} 里
 * 补一段从旧版本升上来的逻辑。加字段不动它——读取侧本来就会给缺失字段落默认值。
 */
export const NIBI_PREFS_VERSION = 1;

export type NibiMotionPreference = "on" | "off";

/** 渲染层偏好的结构。所有字段可选：缺字段就是"没设过"，由调用方落默认值。 */
export interface NibiPrefs {
  version: number;
  /** 主题偏好（`nibi-light` / `nibi-dark` / `system`）。 */
  theme?: string;
  /** 界面动效开关。 */
  motion?: NibiMotionPreference;
  /** 界面语言（BCP 47）。 */
  locale?: string;
}

const violations: string[] = [];

function getLocalStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // 隐私模式/受限环境：访问 localStorage 本身可能抛错。
    return null;
  }
}

/** 键是否在 NIBI 自己的命名空间里。 */
export function isNibiStorageKey(key: string): boolean {
  return NIBI_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * 越界访问的诊断记录（最近 20 条）。
 *
 * 门禁与排查用：越界不是崩溃，而是"这段代码读/写了不属于 NIBI 的键"，
 * 静默吞掉会让这类错误永远看不见。
 */
export function nibiStorageDiagnostics(): readonly string[] {
  return violations.slice();
}

/** 清空诊断（只给测试用：`nibiStorageDiagnostics()` 返回的是副本，改它不会影响内部状态）。 */
export function resetNibiStorageDiagnostics(): void {
  violations.length = 0;
}

function recordViolation(operation: string, key: string): void {
  const entry = `${operation} 被拒绝：${key}`;
  if (violations.includes(entry)) return;
  violations.push(entry);
  if (violations.length > 20) violations.shift();
}

/** 读 NIBI 命名空间下的键；越界返回 `null` 并记诊断。 */
export function readNibiStorage(key: string): string | null {
  if (!isNibiStorageKey(key)) {
    recordViolation("读取", key);
    return null;
  }
  try {
    return getLocalStorage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** 写 NIBI 命名空间下的键；越界不写并记诊断。 */
export function writeNibiStorage(key: string, value: string): void {
  if (!isNibiStorageKey(key)) {
    recordViolation("写入", key);
    return;
  }
  try {
    getLocalStorage()?.setItem(key, value);
  } catch {
    // 隐私模式/受限环境下写失败不影响渲染；下次启动回到默认值。
  }
}

/** 删 NIBI 命名空间下的键；越界不删并记诊断。 */
export function removeNibiStorage(key: string): void {
  if (!isNibiStorageKey(key)) {
    recordViolation("删除", key);
    return;
  }
  try {
    getLocalStorage()?.removeItem(key);
  } catch {
    // 同上。
  }
}

/**
 * 把任意版本的偏好升到当前版本。
 *
 * 这里**只处理 NIBI 自己的旧版本**。上游 ZCode 的值永远不是迁移源：它根本进不来，
 * 因为调用方只会把从 {@link NIBI_PREFS_KEY} 读到的内容交给这个函数。
 */
function migratePrefs(prefs: NibiPrefs): NibiPrefs {
  let next = prefs;
  // 版本 0 = 早于版本化之前写下的偏好（没有 version 字段）。
  // 那一版的键是 nibi:prefs 本身，字段名与现在一致，所以只需要补版本号。
  if (next.version < 1) {
    next = { ...next, version: 1 };
  }
  if (next.version !== NIBI_PREFS_VERSION) {
    // 比当前版本还高：是更新版本写下的数据，按未知字段保留、只补我们的版本号，
    // 不降级、不丢字段（降级不该破坏已有数据）。
    next = { ...next, version: NIBI_PREFS_VERSION };
  }
  return next;
}

/** 读偏好。读不到、解析失败或结构不对时返回空偏好（调用方各自落默认值）。 */
export function readPrefs(): NibiPrefs {
  const raw = readNibiStorage(NIBI_PREFS_KEY);
  if (!raw) {
    return { version: NIBI_PREFS_VERSION };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { version: NIBI_PREFS_VERSION };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { version: NIBI_PREFS_VERSION };
  }
  const record = parsed as Record<string, unknown>;
  const prefs: NibiPrefs = {
    version: typeof record.version === "number" ? record.version : 0,
  };
  if (typeof record.theme === "string") prefs.theme = record.theme;
  if (record.motion === "on" || record.motion === "off") prefs.motion = record.motion;
  if (typeof record.locale === "string") prefs.locale = record.locale;
  return migratePrefs(prefs);
}

/**
 * 改偏好：读-改-写，保持其它字段不动。`undefined` 表示删除该字段。
 *
 * 用 `Reflect` 做动态键合并是刻意的：新增字段时这里不用改，漏改就会静默丢字段。
 */
export function updatePrefs(patch: Partial<Omit<NibiPrefs, "version">>): NibiPrefs {
  const next: NibiPrefs = { ...readPrefs(), version: NIBI_PREFS_VERSION };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      Reflect.deleteProperty(next, key);
    } else {
      Reflect.set(next, key, value);
    }
  }
  writeNibiStorage(NIBI_PREFS_KEY, JSON.stringify(next));
  return next;
}
