import { useRef, useState, type KeyboardEvent } from "react";
import { ArrowUpToLine, Camera, Redo2, Undo2, X } from "lucide-react";
import {
  TID_BROWSER_DESIGN_CAPTURE_ELEMENT,
  TID_BROWSER_DESIGN_ELEMENT,
  TID_BROWSER_DESIGN_INSPECTOR,
  TID_BROWSER_DESIGN_INSPECTOR_CLOSE,
  TID_BROWSER_DESIGN_REDO,
  TID_BROWSER_DESIGN_SAVE_STATUS,
  TID_BROWSER_DESIGN_SELECT_PARENT,
  TID_BROWSER_DESIGN_SOURCE_STATUS,
  TID_BROWSER_DESIGN_STYLE_PROPERTY,
  TID_BROWSER_DESIGN_STYLE_VALUE,
  TID_BROWSER_DESIGN_TEXT_INPUT,
  TID_BROWSER_DESIGN_UNDO,
  TID_BROWSER_DESIGN_VARIABLE_SELECT,
  TID_BROWSER_DESIGN_VARIABLE_VALUE,
} from "@nibi/shared/test-ids";
import {
  DESIGN_STYLE_CSS_NAMES,
  DESIGN_STYLE_PROPERTIES,
  describeDesignElement,
  designStyleValue,
  type DesignStyleProperty,
} from "@/browser-use/browserDesign.js";
import type {
  BrowserDesignModeController,
  DesignSaveState,
} from "@/browser-use/useBrowserDesignMode.js";
import { Button } from "@/components/ui/button.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";

// 画布右下角的紧凑设计检查器：选中元素的 tag/文字、一个 CSS 属性、一个 :root 变量。
// 纯展示：状态与保存动作都来自 useBrowserDesignMode；保存失败原样显示原因，不伪造成功。

const FIELD_CLASS =
  "h-7 w-full min-w-0 rounded-md border border-input-border bg-input px-2 text-ui-sm text-foreground outline-none hover:border-input-border-hover focus:border-input-border-focused focus:bg-input-focused disabled:opacity-60";

function DraftInput({
  disabled,
  initialValue,
  label,
  testId,
  onCommit,
}: {
  disabled: boolean;
  initialValue: string;
  label: string;
  testId: string;
  onCommit: (value: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(initialValue);
  // Esc 放弃输入：blur 同步触发 onBlur 时 draft 还没清掉，用标记跳过提交。
  const cancelledRef = useRef(false);
  const commit = () => {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    if (draft !== initialValue) onCommit(draft);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === "Escape") {
      cancelledRef.current = true;
      setDraft(initialValue);
      event.currentTarget.blur();
    }
  };
  return (
    <input
      aria-label={label}
      className={FIELD_CLASS}
      data-design-draft={draft !== initialValue}
      data-testid={testId}
      disabled={disabled}
      spellCheck={false}
      value={draft}
      onBlur={commit}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={onKeyDown}
    />
  );
}

function saveStateText(state: DesignSaveState, t: (id: string) => string): string | null {
  switch (state.status) {
    case "saving":
      return t("browser.design.save.saving");
    case "saved":
      return t("browser.design.save.saved");
    case "error":
      return t(state.messageId);
    default:
      return null;
  }
}

function sourceStatusText(
  design: BrowserDesignModeController,
  t: (id: string) => string,
): string | null {
  if (!design.canWriteSource) return t("browser.design.source.pageUnavailable");
  if (design.sourceUnreadable) return t("browser.design.source.unreadable");
  if (design.writable === false) return t("browser.design.source.notMatched");
  if (design.writable === null) return t("browser.design.source.checking");
  return null;
}

export function BrowserDesignInspector({
  design,
  onCaptureElement,
}: {
  design: BrowserDesignModeController;
  /** 捕获当前元素并保存为文件；平台不支持时为空，按钮隐藏 */
  onCaptureElement?: () => void;
}): React.JSX.Element {
  const { intl } = useNibiIntl();
  const t = (id: string) => intl.formatMessage({ id });
  const primary = design.primary;
  const [property, setProperty] = useState<DesignStyleProperty>("color");
  const [variableName, setVariableName] = useState("");
  const variables = design.pageInfo?.cssVariables ?? [];
  const activeVariable =
    variables.find((variable) => variable.name === variableName)?.name ?? variables[0]?.name ?? "";
  const variableValue =
    design.variablePreview[activeVariable] ??
    variables.find((variable) => variable.name === activeVariable)?.value ??
    "";

  const disabled = design.writable !== true;
  const saveText = saveStateText(design.saveState, t);
  const sourceText = primary ? sourceStatusText(design, t) : null;
  // 字段里还有没提交的输入时，Cmd/Ctrl + Z 是撤销打字，交给浏览器；回车提交后焦点还在字段上，这时撤销的是写回。
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== "z")
      return;
    const target = event.target as HTMLElement;
    if (target.dataset.designDraft === "true") return;
    event.preventDefault();
    void (event.shiftKey ? design.redo() : design.undo());
  };

  return (
    <aside
      aria-label={t("browser.design.inspector.title")}
      className="absolute right-3 bottom-3 z-20 flex max-h-[calc(100%-4rem)] w-72 flex-col overflow-hidden rounded-xl border border-popover-border bg-popover text-ui-sm text-popover-foreground shadow-lg"
      data-testid={TID_BROWSER_DESIGN_INSPECTOR}
      data-selected-count={design.selections.length}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate font-semibold">
          {primary ? describeDesignElement(primary) : t("browser.design.inspector.title")}
        </span>
        {primary ? (
          <>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label={t("browser.design.edit.parent")}
              data-testid={TID_BROWSER_DESIGN_SELECT_PARENT}
              title={t("browser.design.edit.parent")}
              onClick={design.selectParent}
            >
              <ArrowUpToLine className="size-3.5" />
            </Button>
            {onCaptureElement && design.captureAvailable ? (
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={t("browser.design.captureElement")}
                data-testid={TID_BROWSER_DESIGN_CAPTURE_ELEMENT}
                title={t("browser.design.captureElement")}
                onClick={onCaptureElement}
              >
                <Camera className="size-3.5" />
              </Button>
            ) : null}
          </>
        ) : null}
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={t("browser.design.undo")}
          data-testid={TID_BROWSER_DESIGN_UNDO}
          title={t("browser.design.undo")}
          onClick={() => void design.undo()}
        >
          <Undo2 className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={t("browser.design.redo")}
          data-testid={TID_BROWSER_DESIGN_REDO}
          title={t("browser.design.redo")}
          onClick={() => void design.redo()}
        >
          <Redo2 className="size-3.5" />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={t("browser.design.inspector.close")}
          data-testid={TID_BROWSER_DESIGN_INSPECTOR_CLOSE}
          title={t("browser.design.inspector.close")}
          onClick={design.deactivate}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {primary ? (
          <section className="flex flex-col gap-2 border-b border-border px-3 py-2.5">
            <div className="flex min-w-0 items-baseline gap-1.5">
              <code
                className="shrink-0 rounded bg-input px-1 py-0.5 font-mono text-ui-xs"
                data-testid={TID_BROWSER_DESIGN_ELEMENT}
              >
                {primary.element.tagName}
              </code>
              <span className="min-w-0 flex-1 truncate text-foreground-subtle">
                {primary.element.text || primary.element.accessibleName || ""}
              </span>
            </div>
            {sourceText ? (
              <p
                className="text-ui-xs text-warning"
                data-testid={TID_BROWSER_DESIGN_SOURCE_STATUS}
                data-writable={design.writable === true}
              >
                {sourceText}
              </p>
            ) : null}
            {design.textWritable ? (
              <label className="flex flex-col gap-1">
                <span className="text-ui-xs text-foreground-subtle">
                  {t("browser.design.element.text")}
                </span>
                <DraftInput
                  key={`text:${primary.element.selector ?? ""}:${primary.editable.text ?? ""}`}
                  disabled={disabled}
                  initialValue={primary.editable.text ?? ""}
                  label={t("browser.design.element.text")}
                  testId={TID_BROWSER_DESIGN_TEXT_INPUT}
                  onCommit={(text) => void design.commitText(text)}
                />
              </label>
            ) : null}
            <label className="flex flex-col gap-1">
              <span className="text-ui-xs text-foreground-subtle">
                {t("browser.design.style.property")}
              </span>
              <div className="flex items-center gap-1.5">
                <select
                  aria-label={t("browser.design.style.property")}
                  className="h-7 w-32 shrink-0 rounded-md border border-input-border bg-input px-1.5 text-ui-sm text-foreground hover:border-input-border-hover disabled:opacity-60"
                  data-testid={TID_BROWSER_DESIGN_STYLE_PROPERTY}
                  disabled={disabled}
                  value={property}
                  onChange={(event) => setProperty(event.target.value as DesignStyleProperty)}
                >
                  {DESIGN_STYLE_PROPERTIES.map((item) => (
                    <option key={item} value={item}>
                      {DESIGN_STYLE_CSS_NAMES[item]}
                    </option>
                  ))}
                </select>
                <DraftInput
                  key={`style:${primary.element.selector ?? ""}:${property}:${designStyleValue(primary, property)}`}
                  disabled={disabled}
                  initialValue={designStyleValue(primary, property)}
                  label={t("browser.design.style.value")}
                  testId={TID_BROWSER_DESIGN_STYLE_VALUE}
                  onCommit={(value) => void design.commitStyle(property, value)}
                />
              </div>
            </label>
          </section>
        ) : (
          <p className="px-3 py-3 text-ui-sm text-foreground-subtle">
            {t("browser.design.inspector.empty")}
          </p>
        )}
        <section className="flex flex-col gap-2 px-3 py-2.5">
          <span className="text-ui-xs font-semibold text-foreground">
            {t("browser.design.variable.title")}
          </span>
          {variables.length === 0 ? (
            <p className="text-ui-xs text-foreground-subtle">
              {t("browser.design.variable.empty")}
            </p>
          ) : (
            <div className="flex items-center gap-1.5">
              <select
                aria-label={t("browser.design.variable.name")}
                className="h-7 min-w-0 flex-1 rounded-md border border-input-border bg-input px-1.5 font-mono text-ui-xs text-foreground hover:border-input-border-hover disabled:opacity-60"
                data-testid={TID_BROWSER_DESIGN_VARIABLE_SELECT}
                disabled={!design.canWriteSource}
                value={activeVariable}
                onChange={(event) => setVariableName(event.target.value)}
              >
                {variables.map((variable) => (
                  <option key={variable.name} value={variable.name}>
                    {variable.name}
                  </option>
                ))}
              </select>
              <DraftInput
                key={`variable:${activeVariable}:${variableValue}`}
                disabled={!design.canWriteSource}
                initialValue={variableValue}
                label={t("browser.design.variable.value")}
                testId={TID_BROWSER_DESIGN_VARIABLE_VALUE}
                onCommit={(value) => void design.commitVariable(activeVariable, value)}
              />
            </div>
          )}
        </section>
        {saveText ? (
          <p
            className={
              design.saveState.status === "error"
                ? "border-t border-border px-3 py-2 text-ui-xs text-destructive"
                : "border-t border-border px-3 py-2 text-ui-xs text-foreground-subtle"
            }
            data-state={design.saveState.status}
            data-testid={TID_BROWSER_DESIGN_SAVE_STATUS}
            role={design.saveState.status === "error" ? "alert" : "status"}
          >
            {saveText}
          </p>
        ) : null}
      </div>
    </aside>
  );
}
