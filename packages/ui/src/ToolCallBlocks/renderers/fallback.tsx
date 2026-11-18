import { CheckIcon, CopyIcon, WrenchIcon } from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { ToolCallBody } from "@/ToolCallBlocks/ToolCallBody.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";
import {
  resolveFallbackParameterView,
  resolveFallbackResultView,
  stringifyFallbackValue,
} from "./fallbackModel.js";

const FALLBACK_TOOL_ICON = <WrenchIcon className="size-4 shrink-0 text-foreground-subtle" />;

interface FallbackToolCallBlockProps extends ToolCallBlockRenderContext {
  iconOverride?: ReactNode;
  /** 兼容旧调用点；结构化兜底卡本身不再暴露整包 raw JSON。 */
  hideRawFallback?: boolean;
  summaryOnly?: boolean;
  summaryTextOverride?: ReactNode;
}

/** 参数/结果共用的小节：标题 + 复制；复制失败在节内就地提示，不弹全局 toast。 */
function FallbackSection({
  children,
  label,
  value,
}: {
  children: ReactNode;
  label: string;
  value?: string;
}) {
  const { intl } = useNibiIntl();
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const isCopied = value !== undefined && copiedValue === value;
  const copyLabel = intl.formatMessage({
    id: isCopied ? "chat.message.copy.copied" : "chat.message.copy",
  });

  return (
    <section
      data-fallback-section="true"
      className="min-w-0 space-y-2 [&+section]:border-t [&+section]:border-border [&+section]:pt-3"
    >
      <header className="flex min-h-6 items-center justify-between gap-2 text-ui-sm text-foreground-subtle">
        <h4>{label}</h4>
        {value !== undefined ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            aria-label={`${copyLabel} ${label}`}
            title={copyLabel}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value);
                setCopiedValue(value);
                setCopyFailed(false);
              } catch {
                setCopiedValue(null);
                setCopyFailed(true);
              }
            }}
          >
            {isCopied ? (
              <CheckIcon className="size-3.5" />
            ) : (
              <CopyIcon className="size-3.5" />
            )}
          </Button>
        ) : null}
      </header>
      {copyFailed ? (
        <p role="status" className="text-ui-sm text-destructive">
          {intl.formatMessage({ id: "chat.toolCall.fallback.copyFailed" })}
        </p>
      ) : null}
      <div
        data-fallback-scroll="true"
        className="max-h-60 min-w-0 overflow-auto text-ui-base text-foreground-subtle"
      >
        {children}
      </div>
    </section>
  );
}

function FallbackParameters({ value }: { value: unknown }) {
  const { intl } = useNibiIntl();
  const view = resolveFallbackParameterView(value);

  if (view.kind === "none") {
    return <p>{intl.formatMessage({ id: "chat.toolCall.fallback.noParameters" })}</p>;
  }

  if (view.kind === "raw") {
    return (
      <pre className="whitespace-pre-wrap [overflow-wrap:anywhere]">{view.text}</pre>
    );
  }

  return (
    <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-1.5">
      {view.entries.map((entry) => (
        <div className="contents" key={entry.key}>
          <dt className="min-w-0 whitespace-pre-wrap text-foreground-subtlest [overflow-wrap:anywhere]">
            {entry.key}
          </dt>
          <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{entry.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function FallbackToolCallBlock(context: FallbackToolCallBlockProps) {
  const { intl } = useNibiIntl();
  const {
    toolCallNode,
    isRunning,
    statusLabel,
    errorText,
    childToolList,
    displayModel,
    workspacePath,
    theme,
    codePreviewSettings,
    onOpenCodeViewer,
    onOpenFileLink,
    onOpenBrowserUrl,
  } = context;
  const { toolCall } = toolCallNode;
  const kindLabel =
    toolCall.kind.length > 0
      ? toolCall.kind[0]!.toUpperCase() + toolCall.kind.slice(1)
      : toolCall.kind;
  const hasInlinePreviewOrPlan =
    displayModel.inlinePreview.type !== "none" || displayModel.planResult !== null;
  const handleLoadFullToolCallFields = context.onLoadFullToolCallFields;
  const resultView = useMemo(
    () =>
      resolveFallbackResultView({
        errorText,
        isRunning,
        output: toolCall.output,
        status: toolCall.status,
        statusLabel,
      }),
    [errorText, isRunning, statusLabel, toolCall.output, toolCall.status],
  );
  const parametersLabel = intl.formatMessage({ id: "chat.toolCall.mcp.parameters" });
  const resultLabel = intl.formatMessage({ id: "chat.toolCall.result" });
  const resultSectionLabel =
    resultView.kind === "error" ||
    ((resultView.kind === "waiting" || resultView.kind === "empty") &&
      resultView.label === "error")
      ? intl.formatMessage({ id: "chat.toolCall.fallback.error" })
      : resultLabel;
  const resultSectionValue =
    resultView.kind === "error" || resultView.kind === "result" ? resultView.text : undefined;

  const renderContent = useCallback(
    () => (
      <>
        {childToolList ?? (
          <div
            className="min-w-0 space-y-3 rounded-xl border border-border bg-surface/40 p-3"
            data-fallback-details="true"
          >
            {displayModel.showInput && toolCall.input !== undefined ? (
              <FallbackSection
                label={parametersLabel}
                value={stringifyFallbackValue(toolCall.input)}
              >
                <FallbackParameters value={toolCall.input} />
              </FallbackSection>
            ) : null}
            {hasInlinePreviewOrPlan && resultView.kind !== "error" ? (
              <ToolCallBody
                childToolList={null}
                displayModel={{
                  ...displayModel,
                  showInput: false,
                  showOutput: false,
                  showKind: false,
                }}
                toolCall={toolCall}
                workspacePath={workspacePath}
                theme={theme}
                codePreviewSettings={codePreviewSettings}
                onOpenCodeViewer={onOpenCodeViewer}
                onOpenFileLink={onOpenFileLink}
                onOpenBrowserUrl={onOpenBrowserUrl}
              />
            ) : (
              <FallbackSection label={resultSectionLabel} value={resultSectionValue}>
                {resultView.kind === "waiting" ? (
                  <p className="text-foreground-subtlest">
                    {intl.formatMessage({ id: "chat.toolCall.fallback.waiting" })}
                  </p>
                ) : resultView.kind === "empty" ? (
                  <p className="text-foreground-subtlest">
                    {intl.formatMessage({ id: "chat.toolCall.fallback.noResult" })}
                  </p>
                ) : (
                  <pre
                    className={cn(
                      "whitespace-pre-wrap [overflow-wrap:anywhere]",
                      resultView.isString ? "font-sans" : "font-mono",
                    )}
                  >
                    {resultView.text}
                  </pre>
                )}
              </FallbackSection>
            )}
          </div>
        )}
        <ToolSnapshotFieldNotice
          refs={toolCall.snapshotRefs ?? []}
          onLoadFullToolCallFields={
            handleLoadFullToolCallFields
              ? () => handleLoadFullToolCallFields(toolCall.toolId)
              : undefined
          }
        />
      </>
    ),
    [
      childToolList,
      codePreviewSettings,
      displayModel,
      handleLoadFullToolCallFields,
      hasInlinePreviewOrPlan,
      intl,
      onOpenBrowserUrl,
      onOpenCodeViewer,
      onOpenFileLink,
      parametersLabel,
      resultSectionLabel,
      resultSectionValue,
      resultView,
      theme,
      toolCall,
      workspacePath,
    ],
  );

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={context.iconOverride ?? FALLBACK_TOOL_ICON}
      showIcon={context.showIcon !== false}
      canToggle={context.canToggle ?? true}
      forceOpen={context.forceOpen ?? false}
      kindLabel={context.summaryOnly ? null : (context.kindLabelOverride ?? kindLabel)}
      sourceLabel={context.sourceLabel}
      primaryText={
        context.summaryOnly
          ? (context.summaryTextOverride ?? null)
          : (toolCall.title ?? intl.formatMessage({ id: "chat.toolCall.toolCall" }))
      }
      secondaryText={context.summaryOnly || toolCall.status === "failed" ? undefined : statusLabel}
      statusLabel={toolCall.status === "failed" ? statusLabel : undefined}
      statusTooltip={toolCall.status === "failed" ? errorText : undefined}
      showFailureStatus={toolCall.status === "failed"}
      isRunning={isRunning}
      title={
        context.summaryOnly && typeof context.summaryTextOverride === "string"
          ? context.summaryTextOverride
          : toolCall.title
      }
      renderContent={renderContent}
    />
  );
}
