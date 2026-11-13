/** 面板内 DOM 事件统一使用 NIBI 名；第三方插件已下线，不再派发旧品牌事件。 */
export function dispatchPanelEvent(name: string, detail?: unknown): void {
  const init = detail === undefined ? undefined : { detail };
  window.dispatchEvent(new CustomEvent(name, init));
}
