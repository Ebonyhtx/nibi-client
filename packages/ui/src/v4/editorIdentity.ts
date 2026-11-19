// v4 编辑器身份（U36 queue edit lock）。
//
// editorId 标识「本标签页里的这个编辑器」，不是 clientId：同一个 client 可以开多个窗口/标签，
// 锁必须精确到正在编辑的那一个。sessionStorage 在刷新后保留、复制标签页时会被复制，所以
// 不能单独作为身份——复制出来的标签页会与源标签页拿到同一个 editorId，互相“以为是自己”。
// 用 Web Locks 的 ifAvailable 探测：先拿到同名锁的标签页保留 id，后来者发现锁已被持有就
// 生成新 id（会话级，不跨刷新）。
import { uuidv7 } from "@nibi/shared";

const EDITOR_ID_STORAGE_KEY = "nibi-v4-editor-id:v1";
const EDITOR_LOCK_PREFIX = "nibi-v4-editor:";

let cachedEditorId: string | null = null;

function readStoredEditorId(): string | null {
  try {
    return sessionStorage.getItem(EDITOR_ID_STORAGE_KEY);
  } catch {
    // node / 无 storage 环境：退化到进程内缓存。
    return null;
  }
}

function storeEditorId(editorId: string): void {
  try {
    sessionStorage.setItem(EDITOR_ID_STORAGE_KEY, editorId);
  } catch {
    // 同上，忽略。
  }
}

function newEditorId(): string {
  // 与 clientId 同一生成器；uuidv7 时间有序，日志里能看出先后。
  return `editor-${uuidv7()}`;
}

async function holdEditorLock(editorId: string): Promise<void> {
  const locks = (globalThis.navigator as (Navigator & { locks?: LockManager }) | undefined)?.locks;
  if (!locks?.request) return;
  // 持锁到标签页关闭：request 的 promise 在回调返回前不会释放，这里故意永不 resolve。
  // 同一标签页多次调用会重复请求同名锁（正常浏览器里同源同标签页可重入）；失败只记日志。
  try {
    await locks.request(`${EDITOR_LOCK_PREFIX}${editorId}`, { ifAvailable: true }, async (lock) => {
      if (lock) {
        await new Promise<void>(() => {});
        return;
      }
      // 复制标签页带来了同一个 sessionStorage id，但锁已经在源标签页手里：换一个 id。
      if (cachedEditorId !== editorId) return;
      regenerateV4EditorId();
    });
  } catch {
    // Web Locks 不可用/被策略拒绝：退化为仅 sessionStorage 身份。
  }
}

/**
 * 本标签页的稳定 editorId。首次调用写 sessionStorage 并尝试持锁；复制标签页的后来者会自动
 * 换新 id。同步返回（调用方是命令构造路径，不能等锁）。
 */
export function getV4EditorId(): string {
  if (cachedEditorId) return cachedEditorId;
  const stored = readStoredEditorId();
  const editorId = stored ?? newEditorId();
  cachedEditorId = editorId;
  if (!stored) storeEditorId(editorId);
  void holdEditorLock(editorId);
  return editorId;
}

/** 显式换一个 editorId（复制标签页探测失败或用户重开编辑会话时）。 */
export function regenerateV4EditorId(): string {
  const editorId = newEditorId();
  cachedEditorId = editorId;
  storeEditorId(editorId);
  void holdEditorLock(editorId);
  return editorId;
}

/** 测试用：清掉进程内缓存（sessionStorage 不动）。 */
export function resetV4EditorIdCacheForTests(): void {
  cachedEditorId = null;
}
