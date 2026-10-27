/* eslint-disable max-lines -- Model Provider 设置页需要集中编排导航、表单和模板创建，后续整体拆分时再收敛。 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { marketingNavigation, finishMarketingNavigation } from "@/lib/marketingNavigation.js";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import type { ModelConnectivityResult } from "@nibi/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useModelProviders } from "@/hooks/useModelProviders.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { logger } from "@/logger.js";
import type { ModelProviderNavGroup } from "./model-provider-section/constants.js";
import { ModelProviderSectionDetail } from "./model-provider-section/Detail.js";
import { ModelProviderSectionLayout } from "./model-provider-section/SectionLayout.js";
import { ProviderTemplatePicker } from "./model-provider-section/ProviderTemplatePicker.js";
import { useModelProviderNavigation } from "./model-provider-section/useModelProviderNavigation.js";
import { createCustomProviderNodeKey } from "./model-provider-section/utils.js";
import {
  confirmAndDeleteModelProvider,
  refreshModelProviderSection,
} from "./model-provider-section/modelProviderActions.js";
import { sortModelProvidersForDisplay } from "@/lib/modelProviderOrdering.js";
import {
  addPendingSettingsSectionListener,
  consumePendingSettingsModelProviderTarget,
  type SettingsModelProviderTarget,
} from "@/lib/settingsNavigation.js";

export {
  fuzzyMatch,
  handleEndpointSuggestionPopoverOpenAutoFocus,
  resolveEndpointSuggestionOpenRequest,
} from "./model-provider-section/utils.js";

/**
 * 已下线的上游账号/套餐 provider 不再参与模型供应商设置。
 * 标准 API Key 供应商（api-key / 自定义 endpoint）保持原样。
 */
const HIDDEN_PROVIDER_ACCESS_TYPES = new Set(["zhipu-account", "zhipu-coding-plan-api-key"]);

function isVisibleModelProvider(provider: ProviderSettingsFormProvider): boolean {
  return !HIDDEN_PROVIDER_ACCESS_TYPES.has(provider.config.access?.type ?? "");
}

/**
 * 模型 Provider 设置只由 SettingsPage 注入 Local Host；这里不接收 workspaceIdentity，
 * 防止远程 workspace 误将 Provider Settings 的读写路由到远端 Environment。
 */
export function ModelProviderSection({
  workspacePath = "",
  connectivityWorkspacePath,
  connectivityWorkspaceRequired = false,
  pendingModelProviderTarget,
  onConsumePendingModelProviderTarget,
}: {
  workspacePath?: string;
  connectivityWorkspacePath?: string;
  connectivityWorkspaceRequired?: boolean;
  pendingModelProviderTarget?: SettingsModelProviderTarget;
  onConsumePendingModelProviderTarget?: () => void;
} = {}) {
  const { intl, locale } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const platform = usePlatform();
  const {
    modelProviders,
    providerTemplates,
    displayOrder,
    loading,
    loadError,
    reload,
    refresh,
    refreshing: modelProvidersRefreshing,
    saveProvider,
    createPersonalProvider,
    addPersonalModel,
    savePersonalModelDraft,
    setPersonalModelEnabled,
    deletePersonalModel,
    deleteProvider,
    reorderProviderModels,
    saveDisplayOrder,
    reorderableProviderIds,
    testModelConnectivity,
    providerSettingsView,
  } = useModelProviders({
    workspacePath,
    connectivityWorkspacePath,
    connectivityWorkspaceRequired,
    connectivityUnavailableMessage: intl.formatMessage({
      id: "settings.modelProvider.testModel.localWorkspaceUnavailable",
    }),
  });

  const visibleModelProviders = useMemo(
    () => modelProviders.filter(isVisibleModelProvider),
    [modelProviders],
  );
  const visibleModelProviderIds = useMemo(
    () => new Set(visibleModelProviders.map((provider) => provider.providerId)),
    [visibleModelProviders],
  );
  const [initialModelProviderTarget] = useState(() => consumePendingSettingsModelProviderTarget());
  const [invalidProviderTarget, setInvalidProviderTarget] = useState(false);
  const [selectedNodeKey, setSelectedNodeKey] = useState<string | null>(null);
  const [pendingCreatedProviderId, setPendingCreatedProviderId] = useState<string | null>(null);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [creatingProvider, setCreatingProvider] = useState(false);

  useEffect(() => {
    if (
      !pendingCreatedProviderId ||
      !modelProviders.some((provider) => provider.providerId === pendingCreatedProviderId)
    ) {
      return;
    }
    // saveProvider 会先发布共享快照，再异步落盘；React 在高负载下可能先提交
    // selectedNodeKey、后提交 provider 列表。导航校正会把暂时不存在的 custom key 回退，
    // 新 provider 随后出现也不会再自动选中。只在列表事实可见后完成选中与草稿清理。
    setSelectedNodeKey(createCustomProviderNodeKey(pendingCreatedProviderId));
    setPendingCreatedProviderId(null);
  }, [modelProviders, pendingCreatedProviderId]);

  const applyModelProviderTarget = useCallback(
    (target: SettingsModelProviderTarget | undefined) => {
      if (!target) return false;
      if (!visibleModelProviderIds.has(target.providerId)) {
        // 未知 ID 不能只静默忽略：pending 指令不消费的话，外部输入错误会困住导航。
        // 仅显示错误，保留当前可操作页面和持久连接，后续合法导航/手动选择可恢复。
        logger.warn("[ModelProviderSection] 无法打开目标供应商", {
          providerId: target.providerId,
        });
        setInvalidProviderTarget(true);
        setTemplatePickerOpen(false);
        return true;
      }

      setInvalidProviderTarget(false);
      setTemplatePickerOpen(false);
      setSelectedNodeKey(createCustomProviderNodeKey(target.providerId));
      return true;
    },
    [visibleModelProviderIds],
  );

  useEffect(() => {
    if (!pendingModelProviderTarget || loading) {
      return;
    }
    if (applyModelProviderTarget(pendingModelProviderTarget)) {
      onConsumePendingModelProviderTarget?.();
    }
  }, [
    applyModelProviderTarget,
    loading,
    onConsumePendingModelProviderTarget,
    pendingModelProviderTarget,
  ]);

  useEffect(() => {
    if (!initialModelProviderTarget || loading) {
      return;
    }
    applyModelProviderTarget(initialModelProviderTarget);
  }, [applyModelProviderTarget, initialModelProviderTarget, loading]);

  useEffect(
    () =>
      addPendingSettingsSectionListener((section, detail) => {
        if (section !== "modelProvider") {
          return;
        }
        applyModelProviderTarget(
          detail?.modelProviderId
            ? {
                providerId: detail.modelProviderId,
              }
            : undefined,
        );
      }),
    [applyModelProviderTarget],
  );

  const { navigationGroups, navigationItems, selectedNavItem, navigationUnavailable } =
    useModelProviderNavigation({
      modelProviders: visibleModelProviders,
      modelProvidersLoading: loading,
      displayOrder,
      selectedNodeKey,
      setSelectedNodeKey,
      intl,
    });

  const handleSave = useCallback(
    async (config: ProviderSettingsFormProvider) => {
      try {
        await saveProvider(config);
      } catch (error) {
        logger.error("[ModelProviderSection] 保存模型供应商失败", error);
        throw error;
      }
    },
    [saveProvider],
  );

  const handleDelete = useCallback(
    async (provider: ProviderSettingsFormProvider) => {
      await confirmAndDeleteModelProvider({
        provider,
        confirmDialog,
        intl,
        deleteProvider,
      });
    },
    [confirmDialog, deleteProvider, intl],
  );

  const handleOpenApiKeyUrl = useCallback(
    (url: string) => {
      const normalizedUrl = url.trim();
      if (!normalizedUrl) {
        return;
      }
      platform.openExternal(normalizedUrl);
    },
    [platform],
  );

  const handleCreateProvider = useCallback(
    async (input: { templateId?: string; providerName?: string }) => {
      setCreatingProvider(true);
      try {
        const created = await createPersonalProvider({ ...input, locale });
        setPendingCreatedProviderId(created.providerId);
        setSelectedNodeKey(createCustomProviderNodeKey(created.providerId));
        setTemplatePickerOpen(false);
      } catch (error) {
        setPendingCreatedProviderId(null);
        throw error;
      } finally {
        setCreatingProvider(false);
      }
    },
    [createPersonalProvider, locale],
  );

  const marketingRequest = useStore(marketingNavigation, (state) => state.request);
  useEffect(() => {
    if (marketingRequest?.target.page !== "settings" || !marketingRequest.target.provider_id)
      return;
    if (loading || modelProvidersRefreshing) return;
    const providerId = marketingRequest.target.provider_id;
    const item = navigationItems.find((candidate) => candidate.provider.providerId === providerId);
    if (!item) {
      finishMarketingNavigation(marketingRequest.id, new Error("marketing_provider_unavailable"));
      return;
    }
    if (selectedNodeKey !== item.key) {
      // 只定位侧栏节点；禁止复用带 mode 的选择路径，避免营销导航修改连接。
      setSelectedNodeKey(item.key);
    } else if (selectedNavItem) {
      finishMarketingNavigation(marketingRequest.id);
    }
  }, [
    marketingRequest,
    loading,
    modelProvidersRefreshing,
    navigationItems,
    selectedNodeKey,
    selectedNavItem,
  ]);

  const handleReorderProviderIds = useCallback(
    async (orderedGroupProviderIds: string[]) => {
      const groupProviderIdSet = new Set(orderedGroupProviderIds);
      const currentProviderIds = sortModelProvidersForDisplay(
        visibleModelProviders,
        displayOrder,
      ).map((provider) => provider.providerId);
      const insertionIndex = currentProviderIds.findIndex((providerId) =>
        groupProviderIdSet.has(providerId),
      );
      if (insertionIndex < 0) {
        return;
      }
      const nextProviderIds = currentProviderIds.filter(
        (providerId) => !groupProviderIdSet.has(providerId),
      );
      nextProviderIds.splice(insertionIndex, 0, ...orderedGroupProviderIds);
      await saveDisplayOrder({
        providerIds: nextProviderIds,
      });
    },
    [displayOrder, visibleModelProviders, saveDisplayOrder],
  );

  const handleTestModel = useCallback(
    async (providerId: string, modelId: string): Promise<ModelConnectivityResult> => {
      return testModelConnectivity(providerId, modelId);
    },
    [testModelConnectivity],
  );

  // 首屏慢网时之前直接 return null，导致整块模型供应商页空白，
  // 已有的左侧分组 loading 和刷新按钮 loading 都没有机会渲染。
  // 这里改为始终先渲染布局壳子，再按分组展示 loading，避免用户误以为页面坏了。
  const customLoading = loading || modelProvidersRefreshing;

  if (loadError) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center gap-3 text-ui-base">
        <p className="text-destructive">{loadError.message}</p>
        <Button type="button" variant="outline" onClick={reload}>
          {intl.formatMessage({ id: "common.retry" })}
        </Button>
      </div>
    );
  }

  return (
    <ModelProviderSectionLayout
      description={intl.formatMessage({ id: "settings.modelProviderDescription" })}
      refreshLabel={intl.formatMessage({ id: "settings.modelProvider.refresh" })}
      loadingLabel={intl.formatMessage({ id: "common.loading" })}
      customLoading={customLoading}
      onRefresh={() => {
        void refreshModelProviderSection({ refresh });
      }}
      addProviderLabel={intl.formatMessage({ id: "settings.modelProvider.addProviderAction" })}
      onAddProvider={() => setTemplatePickerOpen(true)}
      navigationGroups={navigationGroups}
      selectedNodeKey={selectedNodeKey}
      onSelectNavItem={(item: ModelProviderNavGroup["items"][number]) => {
        setInvalidProviderTarget(false);
        setSelectedNodeKey(item.key);
        setTemplatePickerOpen(false);
      }}
      onReorderProviderIds={handleReorderProviderIds}
      reorderableProviderIds={reorderableProviderIds}
    >
      {(invalidProviderTarget || navigationUnavailable) && !templatePickerOpen ? (
        <p role="alert" className="mb-3 text-ui-base text-destructive">
          {intl.formatMessage({
            id: invalidProviderTarget
              ? "settings.modelProvider.navigationUnavailable"
              : "settings.modelProvider.connectionUnavailable",
          })}
        </p>
      ) : null}
      {templatePickerOpen ? (
        <ProviderTemplatePicker
          templates={providerTemplates}
          creating={creatingProvider}
          onBack={() => setTemplatePickerOpen(false)}
          onCreateFromTemplate={(templateId) => {
            return handleCreateProvider({ templateId });
          }}
          onCreateCustom={(label) => {
            return handleCreateProvider({ providerName: label });
          }}
        />
      ) : (
        <ModelProviderSectionDetail
          providerSettingsView={providerSettingsView}
          selectedNavItem={selectedNavItem}
          onSave={handleSave}
          onAddPersonalModel={addPersonalModel}
          onSavePersonalModelDraft={savePersonalModelDraft}
          onSetPersonalModelEnabled={setPersonalModelEnabled}
          onDeletePersonalModel={deletePersonalModel}
          onDelete={handleDelete}
          onReorderProviderModels={reorderProviderModels}
          onTestModel={handleTestModel}
          onOpenApiKeyUrl={handleOpenApiKeyUrl}
        />
      )}
    </ModelProviderSectionLayout>
  );
}
