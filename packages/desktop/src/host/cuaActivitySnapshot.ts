/**
 * Helper 活动快照 → 宿主展示事件的纯函数。
 *
 * 为什么单独一层：这段映射曾经漏掉 `nativeCursor`（只算进去重键、没放进事件），
 * 结果 daemon 模式下 indicator 仍然画自有光标——在原生 ghost 上又叠一个，而单测
 * 覆盖的是 indicator 而不是"宿主有没有把标记转发出去"。把它抽成纯函数就能直接钉住。
 */
import type { CuaActivityEvent } from "@nibi/shared";

/** `helper_activity` 的原始回包形状（snake_case，可能缺字段）。 */
export interface CuaHelperActivitySnapshot {
  active?: boolean;
  session_id?: string | null;
  action?: string | null;
  summary?: string | null;
  x?: number | null;
  y?: number | null;
  native_cursor?: boolean;
  at?: number;
}

export function cuaActivityEventFromSnapshot(
  snapshot: CuaHelperActivitySnapshot | null,
  now: number = Date.now(),
): CuaActivityEvent {
  const active = snapshot?.active === true;
  const nativeCursor = snapshot?.native_cursor === true;
  const summary =
    typeof snapshot?.summary === "string" && snapshot.summary.trim().length > 0
      ? snapshot.summary
      : undefined;
  return {
    active,
    sessionId:
      typeof snapshot?.session_id === "string" && snapshot.session_id ? snapshot.session_id : null,
    action:
      typeof snapshot?.action === "string" && snapshot.action
        ? snapshot.action
        : active
          ? "input"
          : "idle",
    ...(summary !== undefined ? { summary } : {}),
    ...(typeof snapshot?.x === "number" ? { x: snapshot.x } : {}),
    ...(typeof snapshot?.y === "number" ? { y: snapshot.y } : {}),
    // 坐标保留（只用于给说明标签定位）；这个标记决定 indicator 是否再画自有光标。
    ...(nativeCursor ? { nativeCursor: true } : {}),
    at: typeof snapshot?.at === "number" ? snapshot.at : now,
  };
}

/** 轮询去重键：任何一个会影响展示的字段变了都要重发。 */
export function cuaActivityKey(event: CuaActivityEvent): string {
  return [
    event.active ? "1" : "0",
    event.action,
    event.summary ?? "",
    event.x ?? "",
    event.y ?? "",
    event.nativeCursor ? "1" : "0",
  ].join(":");
}
