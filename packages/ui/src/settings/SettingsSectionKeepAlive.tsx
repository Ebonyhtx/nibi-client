import { createContext, useContext, useState, type ReactNode } from "react";
import type { SettingsSectionId } from "@/lib/settingsNavigation.js";

/**
 * 设置分区保活：
 * - 首次访问才挂载（keep-alive 缓存）；
 * - 只保留当前分区 + 最近访问的一个分区，第三个分区进入时最旧的分区卸载；
 * - 非当前分区用 `hidden` + `inert` + `aria-hidden` 隐藏，不能聚焦、不会被读屏读到，
 *   也不能只是 opacity（否则 tab 仍会进入隐藏表单）。
 *
 * 这里不碰 section 的 key：正常切换不会重建组件，编辑态与滚动位置得以保留。
 * 深层入口（搜索/深链）若需要重置子状态，仍由 SettingsPage 的 navigationVersion 决定。
 */
export interface SettingsSectionRetentionState {
  current: SettingsSectionId;
  previous: SettingsSectionId | null;
}

/**
 * 纯函数便于测试：当前 + 最近访问的一个，去重且最多两个。
 */
export function retainSettingsSections(
  state: SettingsSectionRetentionState,
): readonly SettingsSectionId[] {
  if (!state.previous || state.previous === state.current) return [state.current];
  return [state.current, state.previous];
}

/**
 * 以 render-phase 派生状态同步更新保留集合。
 *
 * 用 effect 更新会让切换后的第一帧只剩新分区（旧分区已被卸载），恰好破坏 keep-alive；
 * 这里在渲染期调整同一组件的 state，React 会在提交前重新渲染，旧分区不会被卸载。
 */
export function useRetainedSettingsSections(
  activeSection: SettingsSectionId,
): readonly SettingsSectionId[] {
  const [retention, setRetention] = useState<SettingsSectionRetentionState>(() => ({
    current: activeSection,
    previous: null,
  }));
  const pendingPrevious =
    retention.current !== activeSection ? retention.current : retention.previous;
  if (retention.current !== activeSection) {
    setRetention({
      current: activeSection,
      previous: retention.current,
    });
  }
  // 渲染期 setState 后 React 会立即用新 state 再渲染一次；两次都必须返回同一份
  // [current, previous]，否则第一次提交会把旧分区卸载，保活失效。
  return retainSettingsSections({ current: activeSection, previous: pendingPrevious });
}

const SettingsSectionActiveContext = createContext(true);

/** 隐藏分区里的订阅/轮询据此暂停；非设置页消费者默认视为 active。 */
export function useSettingsSectionActive(): boolean {
  return useContext(SettingsSectionActiveContext);
}

export function SettingsSectionPane({
  section,
  active,
  children,
}: {
  section: SettingsSectionId;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <SettingsSectionActiveContext.Provider value={active}>
      <div
        data-settings-section-pane={section}
        data-settings-section-active={active ? "true" : "false"}
        hidden={!active}
        inert={!active ? true : undefined}
        aria-hidden={!active ? "true" : undefined}
      >
        {children}
      </div>
    </SettingsSectionActiveContext.Provider>
  );
}
