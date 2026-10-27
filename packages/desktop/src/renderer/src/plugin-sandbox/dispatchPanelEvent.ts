/**
 * 面板内 DOM 事件的兼容派发：NIBI 名为主，旧名同时再派发一次。
 *
 * 为什么需要：插件面板监听的是 DOM 事件（`zcode:set_globals` 等），已发布的第三方面板
 * 里写死了旧名；只改派发名会让它们收不到状态更新（面板看着能用，但主题/状态永远不刷新）。
 * 反之只发旧名又会让新文档教出来的写法失效。所以两个名字都发，detail 完全同源。
 *
 * 与 `window.zcode` 别名同一口径：别名只为一件事存在——已发布插件不失效；
 * 我们自己的面板、技能文档、新写的面板一律用 nibi 名。
 */
export const LEGACY_EVENT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "nibi:error": "zcode:error",
  "nibi:globals": "zcode:globals",
  "nibi:set_globals": "zcode:set_globals",
});

export function dispatchPanelEvent(name: string, detail?: unknown): void {
  const init = detail === undefined ? undefined : { detail };
  window.dispatchEvent(new CustomEvent(name, init));
  const legacy = LEGACY_EVENT_NAMES[name];
  if (legacy) window.dispatchEvent(new CustomEvent(legacy, init));
}
