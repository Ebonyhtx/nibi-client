import type { IServiceAccessor } from "@nibi/services";
import {
  useDataSyncCategory,
  type DataSyncCategoryController,
  type DataSyncCategoryState,
} from "@/data-sync/app/useDataSyncCategory.js";

/** 兼容技能单类调用方：与通用分类状态同形状，`category` 固定为 `skills`。 */
export type DataSyncSkillsState = DataSyncCategoryState;
export type DataSyncSkillsController = DataSyncCategoryController;

/**
 * 技能同步页的状态 owner。实现已泛化到 `useDataSyncCategory`；
 * 保留同名导出与入参，既有技能调用方与测试无需改断言语义。
 */
export function useDataSyncSkills(params: {
  sourceServices: IServiceAccessor | undefined;
  targetServices: IServiceAccessor | undefined;
  online: boolean;
  attachmentError?: string;
}): DataSyncSkillsController {
  return useDataSyncCategory({ ...params, category: "skills" });
}
