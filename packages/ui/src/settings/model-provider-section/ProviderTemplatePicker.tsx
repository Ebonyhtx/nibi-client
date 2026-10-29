import type { ProviderSettingsView } from "@nibi/services";
import { ArrowLeftIcon, ChevronRightIcon, PlusIcon } from "lucide-react";
import { resolveProviderTemplateName } from "@nibi/provider";
import type { ReactNode } from "react";
import {
  TID_MODEL_PROVIDER_TEMPLATE_BACK_BUTTON,
  TID_MODEL_PROVIDER_TEMPLATE_ITEM,
  TID_MODEL_PROVIDER_TEMPLATE_PICKER,
  testId,
} from "@nibi/shared/test-ids";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { ProviderLogo } from "./ProviderLogo.js";
import { useProviderDetailFeedback } from "./ProviderDetailFeedback.js";

type ProviderTemplateCreate = (templateId: string) => Promise<void>;
type CustomProviderCreate = (label: string) => Promise<void>;

type ProviderTemplate = ProviderSettingsView["providerTemplates"][number];

/**
 * 上游订阅套餐模板（Z.ai Coding Plan / BigModel Coding Plan）不进入 NIBI 的模型配置清单。
 * 分家后它们是别家的套餐；用户要接这两家的按量 API，用同厂商的 *-standard-api 模板。
 * 清单由服务端 builtin 快照下发（/api/v1/client/configs），这里按访问类型与已知 id 双重过滤，
 * 服务端清单回退旧版本时也不会把它们放出来。
 */
const HIDDEN_PROVIDER_TEMPLATE_IDS = new Set(["zai-api", "bigmodel-api"]);
const HIDDEN_PROVIDER_TEMPLATE_ACCESS_TYPES = new Set(["zhipu-coding-plan-api-key"]);

export function isProviderTemplateVisible(template: ProviderTemplate): boolean {
  if (HIDDEN_PROVIDER_TEMPLATE_IDS.has(template.templateId)) return false;
  const accessType = (template.config as { access?: { type?: unknown } } | undefined)?.access?.type;
  return !(
    typeof accessType === "string" && HIDDEN_PROVIDER_TEMPLATE_ACCESS_TYPES.has(accessType)
  );
}

export function filterVisibleProviderTemplates(
  templates: ProviderSettingsView["providerTemplates"],
): ProviderSettingsView["providerTemplates"] {
  return templates.filter(isProviderTemplateVisible);
}

export function ProviderTemplatePicker({
  templates,
  onBack,
  onCreateFromTemplate,
  onCreateCustom,
  creating,
}: {
  templates: ProviderSettingsView["providerTemplates"];
  onBack: () => void;
  onCreateFromTemplate: ProviderTemplateCreate;
  onCreateCustom: CustomProviderCreate;
  creating: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const { dismissFeedback, showFeedback } = useProviderDetailFeedback();
  // NIBI：不再特殊对待任何模板——GLM 卡片与其它供应商同组、同地位（内容侧已完成去品牌：
  // 云端清单由服务端转换，随包快照同源）。
  // 原先"智谱模板分组整组隐藏"（zhipuIds + NIBI_SHOW_ZHIPU_TEMPLATES）已移除。
  const customLabel = intl.formatMessage({ id: "settings.modelProvider.newProviderName" });
  const groups = [
    {
      id: "other",
      templates: filterVisibleProviderTemplates(templates),
    },
  ] as const;
  const createWithFeedback = async (create: () => Promise<void>) => {
    const feedbackKey = "provider-template-create";
    dismissFeedback(feedbackKey);
    try {
      await create();
    } catch (error) {
      // Template 创建失败过去只写日志，用户留在选择页却看不到任何结果。
      // 失败继续留在当前页，并复用详情栏底部反馈横幅提供同一次创建的重试入口。
      // 完整 Schema issues 只进入统一 UI 日志；横幅保持可读摘要，避免原始数组撑满详情区。
      logger.error("[ProviderTemplatePicker] 创建供应商失败", error);
      const retry = () => void createWithFeedback(create);
      showFeedback({
        key: feedbackKey,
        state: "failure",
        message: intl.formatMessage({ id: "settings.modelProvider.templateCreateFailed" }),
        actionLabel: intl.formatMessage({ id: "settings.modelProvider.templateCreateRetry" }),
        onAction: retry,
        dismissible: true,
      });
    }
  };
  return (
    <section className="space-y-5" data-testid={TID_MODEL_PROVIDER_TEMPLATE_PICKER}>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid={TID_MODEL_PROVIDER_TEMPLATE_BACK_BUTTON}
          aria-label={intl.formatMessage({ id: "settings.modelProvider.templatePickerBack" })}
          onClick={onBack}
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
        </Button>
        <h2 className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.modelProvider.templatePickerTitle" })}
        </h2>
      </div>

      <div className="space-y-6">
        {groups.map((group) => (
          <section key={group.id} data-provider-template-group={group.id} className="space-y-3">
            <h3 className="text-ui-base font-medium text-foreground-subtle">
              {intl.formatMessage({ id: `settings.modelProvider.templateGroup.${group.id}` })}
            </h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {group.id === "other" ? (
                <ProviderTemplateCard
                  label={intl.formatMessage({ id: "settings.modelProvider.createCustomProvider" })}
                  disabled={creating}
                  testId={testId(TID_MODEL_PROVIDER_TEMPLATE_ITEM, "custom")}
                  icon={
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-hover">
                      <PlusIcon className="size-4" aria-hidden="true" />
                    </span>
                  }
                  onClick={() => void createWithFeedback(() => onCreateCustom(customLabel))}
                />
              ) : null}
              {group.templates.map((template) => {
                const label = resolveProviderTemplateName(template.templateId, template, locale);
                return (
                  <ProviderTemplateCard
                    key={template.templateId}
                    label={label}
                    disabled={creating}
                    testId={testId(TID_MODEL_PROVIDER_TEMPLATE_ITEM, template.templateId)}
                    icon={
                      <span className="flex size-9 shrink-0 items-center justify-center">
                        <ProviderLogo logo={template.config.logo} className="size-8" />
                      </span>
                    }
                    onClick={() =>
                      void createWithFeedback(() => onCreateFromTemplate(template.templateId))
                    }
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function ProviderTemplateCard({
  label,
  disabled,
  testId: cardTestId,
  icon,
  onClick,
}: {
  label: string;
  disabled: boolean;
  testId: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <ControlHintTooltip title={label}>
      <button
        type="button"
        data-testid={cardTestId}
        disabled={disabled}
        onClick={onClick}
        className="flex min-h-16 min-w-0 items-center gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-left transition-colors outline-none hover:border-border-hover hover:bg-hover focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:opacity-60"
      >
        {icon}
        <span className="min-w-0 flex-1 break-words text-ui-base font-medium">{label}</span>
        <ChevronRightIcon className="size-4 shrink-0 text-foreground-subtlest" aria-hidden="true" />
      </button>
    </ControlHintTooltip>
  );
}
