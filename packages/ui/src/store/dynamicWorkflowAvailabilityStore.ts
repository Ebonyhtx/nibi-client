import { create } from "zustand";
import {
  applyDynamicWorkflowUserMode,
  createDynamicWorkflowClientConfig,
  type DynamicWorkflowClientConfig,
  type DynamicWorkflowMode,
} from "@nibi/shared";

// ============================================================
// 动态工作流灰度快照在 renderer 的唯一副本
// ============================================================
//
// NIBI 不再从上游套餐服务读取灰度：默认提供动态工作流（alwaysOn），
// 用户选择仍由设置文件决定。Root 的 loader 发布默认快照，自动化页与 run 面板只读。

export type DynamicWorkflowAvailabilityStatus = "loading" | "ready";

export interface DynamicWorkflowAvailabilitySnapshot {
  readonly status: DynamicWorkflowAvailabilityStatus;
  /** loading 期间恒为 false：未知即不提供，入口宁可晚半拍出现也不闪一下再收起。 */
  readonly enabled: boolean;
  /**
   * 未就绪或取数失败时为 null；`source` 只用于观测，区分「服务端关」与「本地覆盖」。
   * `offeredMode` 是服务端提供的默认模式（哪个选项标「默认」），`mode` 是生效模式。
   */
  readonly config: DynamicWorkflowClientConfig | null;
}

interface DynamicWorkflowAvailabilityState extends DynamicWorkflowAvailabilitySnapshot {
  /** NIBI 默认提供动态工作流；首次调用后即就绪。 */
  ensureLoaded(): Promise<void>;
  /** 重新发布默认快照。 */
  refresh(): Promise<void>;
  /** 用户选择变化后重新应用本窗口生效值。 */
  reload(): Promise<void>;
  /** 应用设置里的用户选择（不影响 Host 的默认提供）。 */
  setUserMode(mode: DynamicWorkflowMode | undefined): void;
}

const INITIAL_SNAPSHOT: DynamicWorkflowAvailabilitySnapshot = {
  status: "loading",
  enabled: false,
  config: null,
};

const DEFAULT_DYNAMIC_WORKFLOW_OFFER = createDynamicWorkflowClientConfig("alwaysOn", "default");
let currentUserMode: DynamicWorkflowMode | undefined;
let settled = false;

function buildDefaultSnapshot(): DynamicWorkflowAvailabilitySnapshot {
  const config = applyDynamicWorkflowUserMode(DEFAULT_DYNAMIC_WORKFLOW_OFFER, currentUserMode);
  return { status: "ready", enabled: config.enabled, config };
}

export const useDynamicWorkflowAvailabilityStore = create<DynamicWorkflowAvailabilityState>(
  (set, get) => ({
    ...INITIAL_SNAPSHOT,

    ensureLoaded(): Promise<void> {
      if (settled) return Promise.resolve();
      settled = true;
      set(buildDefaultSnapshot());
      return Promise.resolve();
    },

    refresh(): Promise<void> {
      set(buildDefaultSnapshot());
      return Promise.resolve();
    },

    reload(): Promise<void> {
      set(buildDefaultSnapshot());
      return Promise.resolve();
    },

    setUserMode(mode): void {
      currentUserMode = mode;
      set(buildDefaultSnapshot());
    },
  }),
);

/** 测试用：清掉快照与就绪闩。 */
export function resetDynamicWorkflowAvailabilityStoreForTests(): void {
  settled = false;
  currentUserMode = undefined;
  useDynamicWorkflowAvailabilityStore.setState({ ...INITIAL_SNAPSHOT });
}
