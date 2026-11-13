import { useCallback, useState } from "react";
import type { SettingsSyncImportResult, SettingsSyncSelection } from "@nibi/shared";
import { useServices } from "@/hooks/useServices.js";
import { invalidateDeferredDraftSessionForSkillChange } from "@/lib/nibiDraftSkillInvalidation.js";
import { logger } from "@/logger.js";
import type { UnifiedMigrationSettingsImport } from "@/onboarding/useOnboardingMigration.js";

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface MigrationWizardSettingsImportState extends UnifiedMigrationSettingsImport {
  state: {
    result: SettingsSyncImportResult | null;
    error: string | null;
  };
  actions: UnifiedMigrationSettingsImport["actions"] & {
    reset: () => void;
  };
}

/**
 * 设置页迁移向导的设置导入适配器。
 * 统一执行器只依赖 selectedCount + startImportWithAdditionalSelections；
 * 这里直接调用 settingsSyncService，允许在没有 active workspace 时按全局 target 导入。
 */
export function useMigrationWizardSettingsImport(params: {
  workspacePath: string | null;
  workspaceIdentity?: string;
}): MigrationWizardSettingsImportState {
  const { settingsSyncService } = useServices();
  const [result, setResult] = useState<SettingsSyncImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startImportWithAdditionalSelections = useCallback(
    async (
      additionalSelections: SettingsSyncSelection[] = [],
      _options: { includeCurrentSelections?: boolean } = {},
    ) => {
      if (additionalSelections.length === 0) {
        return;
      }

      setError(null);
      setResult(null);
      try {
        const importResult = await settingsSyncService.importSelected({
          workspacePath: params.workspacePath ?? undefined,
          workspaceIdentity: params.workspaceIdentity,
          selections: additionalSelections,
        });
        setResult(importResult);
        if (additionalSelections.some((selection) => selection.category === "skills")) {
          await invalidateDeferredDraftSessionForSkillChange({
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
            reason: "settings-sync-skill-import",
          });
        }
        logger.info("[settings-migration-wizard] settings import completed", {
          workspacePath: params.workspacePath,
          selections: additionalSelections.length,
          result: importResult,
        });
      } catch (importError) {
        const message = normalizeError(importError);
        logger.error("[settings-migration-wizard] settings import failed", {
          workspacePath: params.workspacePath,
          error: message,
        });
        setError(message);
        throw importError;
      }
    },
    [params.workspaceIdentity, params.workspacePath, settingsSyncService],
  );

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return {
    // 设置页迁移向导不导入 onboarding 的 providers 选择。
    selectedCount: 0,
    state: { result, error },
    actions: { startImportWithAdditionalSelections, reset },
  };
}
