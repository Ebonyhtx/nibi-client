import {
  getThemeSwatchDotProps,
  resolveCanonicalThemeMode,
  resolveTheme,
  THEME_SWATCH_META,
  type CanonicalThemeMode,
  type Theme,
} from "@/useTheme.js";
import { useEffect, useState } from "react";
import { Check, Minus, Plus } from "lucide-react";
import { Switch } from "@/components/ui/switch.js";
import {
  getThemeOptionLabel,
  SettingsGroupCard,
  SettingsRow,
  ThemePreviewCard,
  ThemeSelect,
} from "@/settings/SettingsPageParts.js";
import { getCodePreviewTheme } from "@/lib/codePreviewPreferences.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import type { CodePreviewSettings } from "@/store/index.js";
import { THEME_MODES } from "@/settings/settingsPageConfig.js";
import { CompanionSettingsRows } from "@/settings/CompanionSettingsRows.js";
import { MAX_UI_FONT_SIZE_PX, MIN_UI_FONT_SIZE_PX } from "@/lib/uiFontSize.js";
import { cn } from "@/components/lib/utils.js";

function FontSizeInput({
  value,
  min,
  max,
  ariaLabel,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  ariaLabel: string;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const applyClamped = (raw: number) => {
    const nextValue = Math.min(max, Math.max(min, Math.round(raw)));
    setDraft(String(nextValue));
    if (nextValue !== value) {
      onChange(nextValue);
    }
  };

  const commit = () => {
    const parsed = draft.trim() === "" ? Number.NaN : Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    applyClamped(parsed);
  };

  return (
    <div
      data-font-size-stepper=""
      className="inline-flex h-8 items-center overflow-hidden rounded-lg border border-input-border bg-card shadow-[var(--nibi-shadow-input-inset)] transition-[border-color,box-shadow] focus-within:border-input-border-focused focus-within:ring-2 focus-within:ring-input-border-focused/25"
    >
      <button
        type="button"
        aria-label={`${ariaLabel} -`}
        disabled={value <= min}
        onClick={() => applyClamped(value - 1)}
        className="flex h-full w-7 shrink-0 items-center justify-center border-r border-border/55 text-foreground/80 transition-colors hover:bg-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
      >
        <Minus className="size-3.5" aria-hidden="true" />
      </button>
      <div className="flex h-full items-center gap-1 px-2">
        <input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={draft}
          aria-label={ariaLabel}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setDraft(String(value));
            }
          }}
          className="w-7 bg-transparent text-center text-ui-base font-medium tabular-nums text-foreground outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <span aria-hidden="true" className="select-none text-ui-xs text-foreground-subtle">
          px
        </span>
      </div>
      <button
        type="button"
        aria-label={`${ariaLabel} +`}
        disabled={value >= max}
        onClick={() => applyClamped(value + 1)}
        className="flex h-full w-7 shrink-0 items-center justify-center border-l border-border/55 text-foreground/80 transition-colors hover:bg-hover hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
      >
        <Plus className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

function ThemeGallerySpecimen({ mode }: { mode: CanonicalThemeMode }) {
  const spec = THEME_SWATCH_META[mode];
  if (spec.splitDark) {
    return (
      <div
        aria-hidden="true"
        className="relative aspect-[16/10] w-full overflow-hidden rounded-lg border"
        style={{ borderColor: spec.border, backgroundColor: spec.desk }}
      >
        <div className="flex h-full w-full">
          <div
            className="flex h-full w-1/2 flex-col justify-between p-1.5"
            style={{ backgroundColor: spec.desk }}
          >
            <div className="flex items-center gap-1">
              <span className="size-1.5 rounded-full" style={{ backgroundColor: spec.accent }} />
              <span
                className="h-1 w-5 rounded-full opacity-55"
                style={{ backgroundColor: spec.ink }}
              />
            </div>
            <div
              className="rounded-md border px-1.5 py-1 shadow-2xs"
              style={{ backgroundColor: spec.sheet, borderColor: spec.border }}
            >
              <div
                className="font-display text-[11px] font-semibold leading-none"
                style={{ color: spec.ink }}
              >
                Aa
              </div>
            </div>
          </div>
          <div
            className="flex h-full w-1/2 flex-col justify-between p-1.5"
            style={{ backgroundColor: spec.splitDark.desk }}
          >
            <div className="flex items-center justify-end gap-1">
              <span
                className="h-1 w-5 rounded-full opacity-55"
                style={{ backgroundColor: spec.splitDark.ink }}
              />
              <span
                className="size-1.5 rounded-full"
                style={{ backgroundColor: spec.splitDark.accent }}
              />
            </div>
            <div
              className="rounded-md border px-1.5 py-1 shadow-2xs"
              style={{
                backgroundColor: spec.splitDark.sheet,
                borderColor: spec.splitDark.border,
              }}
            >
              <div
                className="text-right font-display text-[11px] font-semibold leading-none"
                style={{ color: spec.splitDark.ink }}
              >
                文
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div
      aria-hidden="true"
      className="relative flex aspect-[16/10] w-full gap-1.5 overflow-hidden rounded-lg border p-1.5"
      style={{ borderColor: spec.border, backgroundColor: spec.desk }}
    >
      <div className="flex w-1/4 shrink-0 flex-col gap-1 pt-0.5">
        <span
          className="h-2.5 w-full rounded-[4px] border"
          style={{ backgroundColor: spec.sheet, borderColor: spec.border }}
        />
        <span className="h-1 w-4/5 rounded-full opacity-35" style={{ backgroundColor: spec.ink }} />
        <span className="h-1 w-3/5 rounded-full opacity-25" style={{ backgroundColor: spec.ink }} />
      </div>
      <div
        className="flex min-w-0 flex-1 flex-col justify-between rounded-md border p-1.5 shadow-2xs"
        style={{ backgroundColor: spec.sheet, borderColor: spec.border }}
      >
        <div className="flex items-center justify-between">
          <span
            className="font-display text-[12px] font-semibold leading-none"
            style={{ color: spec.ink }}
          >
            Aa 文
          </span>
          <span className="size-1.5 rounded-full" style={{ backgroundColor: spec.accent }} />
        </div>
        <div className="space-y-1">
          <span
            className="block h-1 w-5/6 rounded-full opacity-35"
            style={{ backgroundColor: spec.ink }}
          />
          <span
            className="block h-1 w-3/5 rounded-full opacity-20"
            style={{ backgroundColor: spec.ink }}
          />
        </div>
      </div>
    </div>
  );
}

function ThemePaletteGallery({
  theme,
  onSelect,
}: {
  theme: Theme;
  onSelect: (theme: Theme) => void;
}) {
  const { intl } = useNibiIntl();
  const activeMode = resolveCanonicalThemeMode(theme);

  return (
    <div
      role="radiogroup"
      aria-label={intl.formatMessage({ id: "settings.themeMode" })}
      className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5"
    >
      {THEME_MODES.map(({ mode, icon: Icon }) => {
        const canonicalMode = resolveCanonicalThemeMode(mode);
        const selected = activeMode === canonicalMode;
        const label = intl.formatMessage({ id: `settings.themeMode.${mode}` });
        return (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={selected}
            data-testid={`appearance-theme-card-${mode}`}
            onClick={() => onSelect(mode)}
            className={cn(
              "group/theme-card flex min-w-0 cursor-pointer flex-col gap-2 rounded-xl border p-2 text-left transition-[border-color,background-color,box-shadow] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
              selected
                ? "border-primary bg-card shadow-[var(--nibi-shadow-card-hover)] ring-2 ring-primary/20"
                : "border-border/75 bg-card/60 hover:border-border-hover hover:bg-card",
            )}
          >
            <ThemeGallerySpecimen mode={canonicalMode} />
            <div className="flex min-w-0 items-center justify-between gap-1.5 px-0.5 py-0.5">
              <span className="flex min-w-0 items-center gap-1.5">
                <Icon
                  aria-hidden="true"
                  className={cn(
                    "size-3.5 shrink-0 transition-colors",
                    selected ? "text-primary" : "text-foreground-subtle group-hover/theme-card:text-foreground",
                  )}
                />
                <span className="truncate text-ui-sm font-medium text-foreground">{label}</span>
              </span>
              {selected ? (
                <Check aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
              ) : null}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function AppearanceSectionContent({
  codePreviewSettings,
  setCodePreviewSettings,
  theme,
  setTheme,
  uiFontSizePx,
  setUiFontSizePx,
  motionEnabled,
  setMotionEnabled,
  isMacDesktop = false,
  macFontSmoothingEnabled = true,
  setMacFontSmoothingEnabled = () => {},
}: {
  codePreviewSettings: CodePreviewSettings;
  setCodePreviewSettings: (settings: Partial<CodePreviewSettings>) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  uiFontSizePx: number;
  setUiFontSizePx: (fontSizePx: number) => void;
  motionEnabled: boolean;
  setMotionEnabled: (enabled: boolean) => void;
  isMacDesktop?: boolean;
  macFontSmoothingEnabled?: boolean;
  setMacFontSmoothingEnabled?: (enabled: boolean) => void;
}) {
  const { intl } = useNibiIntl();
  const activePreviewMode = resolveTheme(theme);
  const activeThemeMode = resolveCanonicalThemeMode(theme);
  const activeThemeLabel = intl.formatMessage({ id: `settings.themeMode.${activeThemeMode}` });

  return (
    <div className="space-y-8">
      <SettingsGroupCard
        title={intl.formatMessage({ id: "settings.appearance.interfaceTitle" })}
        description={intl.formatMessage({
          id: "settings.appearance.interfaceDescription",
        })}
      >
        <SettingsRow
          searchTarget="appearance.theme"
          label={intl.formatMessage({ id: "settings.themeMode" })}
          description={intl.formatMessage({
            id: "settings.themeModeDescription",
          })}
          control={
            <span
              data-testid="appearance-theme-active-badge"
              className="inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-surface/75 px-2.5 py-1 text-ui-sm font-medium text-foreground"
            >
              <span {...getThemeSwatchDotProps(theme)} />
              <span>{activeThemeLabel}</span>
            </span>
          }
          detail={<ThemePaletteGallery theme={theme} onSelect={setTheme} />}
        />
        <SettingsRow
          searchTarget="appearance.uiFontSize"
          label={intl.formatMessage({ id: "settings.uiFontSize" })}
          description={intl.formatMessage({
            id: "settings.uiFontSizeDescription",
          })}
          control={
            <FontSizeInput
              key={uiFontSizePx}
              min={MIN_UI_FONT_SIZE_PX}
              max={MAX_UI_FONT_SIZE_PX}
              value={uiFontSizePx}
              onChange={setUiFontSizePx}
              ariaLabel={intl.formatMessage({ id: "settings.uiFontSize" })}
            />
          }
        />
        {isMacDesktop ? (
          <SettingsRow
            searchTarget="appearance.fontSmoothing"
            label={intl.formatMessage({ id: "settings.macFontSmoothing" })}
            description={intl.formatMessage({
              id: "settings.macFontSmoothingDescription",
            })}
            control={
              <Switch
                checked={macFontSmoothingEnabled}
                aria-label={intl.formatMessage({ id: "settings.macFontSmoothing" })}
                data-testid="settings-macos-font-smoothing"
                onCheckedChange={setMacFontSmoothingEnabled}
              />
            }
          />
        ) : null}
        <SettingsRow
          searchTarget="appearance.motion"
          label={intl.formatMessage({ id: "settings.motionEnabled" })}
          description={intl.formatMessage({
            id: "settings.motionEnabledDescription",
          })}
          control={<Switch checked={motionEnabled} onCheckedChange={setMotionEnabled} />}
        />
      </SettingsGroupCard>

      <CompanionSettingsRows />

      <SettingsGroupCard
        title={intl.formatMessage({ id: "settings.appearance.codeTitle" })}
        description={intl.formatMessage({
          id: "settings.appearance.codeDescription",
        })}
        cardClassName="[&_[data-slot=select-trigger]]:w-full"
      >
        <SettingsRow
          searchTarget="appearance.codeLightTheme"
          label={intl.formatMessage({ id: "settings.lightTheme" })}
          description={intl.formatMessage({
            id: "settings.lightThemeDescription",
          })}
          control={
            <ThemeSelect
              value={codePreviewSettings.lightTheme}
              onValueChange={(value) => setCodePreviewSettings({ lightTheme: value })}
            />
          }
        />
        <SettingsRow
          searchTarget="appearance.codeDarkTheme"
          label={intl.formatMessage({ id: "settings.darkTheme" })}
          description={intl.formatMessage({
            id: "settings.darkThemeDescription",
          })}
          control={
            <ThemeSelect
              value={codePreviewSettings.darkTheme}
              onValueChange={(value) => setCodePreviewSettings({ darkTheme: value })}
            />
          }
        />
        <SettingsRow
          searchTarget="appearance.showLineNumbers"
          label={intl.formatMessage({ id: "settings.showLineNumbers" })}
          description={intl.formatMessage({
            id: "settings.showLineNumbersDescription",
          })}
          control={
            <Switch
              checked={codePreviewSettings.showLineNumbers}
              onCheckedChange={(checked) =>
                setCodePreviewSettings({ showLineNumbers: checked })
              }
            />
          }
        />
        <SettingsRow
          searchTarget="appearance.wrapLongLines"
          label={intl.formatMessage({ id: "settings.wrapLongLines" })}
          description={intl.formatMessage({
            id: "settings.wrapLongLinesDescription",
          })}
          control={
            <Switch
              checked={codePreviewSettings.wrapLongLines}
              onCheckedChange={(checked) =>
                setCodePreviewSettings({ wrapLongLines: checked })
              }
            />
          }
        />
        <SettingsRow
          searchTarget="appearance.codeFontSize"
          label={intl.formatMessage({ id: "settings.fontSize" })}
          description={intl.formatMessage({
            id: "settings.fontSizeDescription",
          })}
          control={
            <FontSizeInput
              key={codePreviewSettings.fontSizePx}
              min={12}
              max={20}
              value={codePreviewSettings.fontSizePx}
              onChange={(fontSizePx) => setCodePreviewSettings({ fontSizePx })}
              ariaLabel={intl.formatMessage({ id: "settings.fontSize" })}
            />
          }
        />
      </SettingsGroupCard>

      <section className="min-w-0 space-y-3">
        <div className="px-1.5">
          <h3 className="font-display text-ui-lg font-semibold leading-[1.35] tracking-[-0.01em] text-foreground">
            {intl.formatMessage({ id: "settings.previewSectionTitle" })}
          </h3>
          <p className="mt-1 text-ui-sm leading-5 text-foreground-subtle">
            {intl.formatMessage({ id: "settings.previewDescription" })}
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <ThemePreviewCard
            mode="light"
            title={intl.formatMessage({ id: "settings.previewLight" })}
            themeName={getThemeOptionLabel(codePreviewSettings.lightTheme)}
            theme={getCodePreviewTheme("light", codePreviewSettings)}
            isActive={activePreviewMode === "light"}
            showLineNumbers={codePreviewSettings.showLineNumbers}
            wrapLongLines={codePreviewSettings.wrapLongLines}
            fontSizePx={codePreviewSettings.fontSizePx}
          />
          <ThemePreviewCard
            mode="dark"
            title={intl.formatMessage({ id: "settings.previewDark" })}
            themeName={getThemeOptionLabel(codePreviewSettings.darkTheme)}
            theme={getCodePreviewTheme("dark", codePreviewSettings)}
            isActive={activePreviewMode === "dark"}
            showLineNumbers={codePreviewSettings.showLineNumbers}
            wrapLongLines={codePreviewSettings.wrapLongLines}
            fontSizePx={codePreviewSettings.fontSizePx}
          />
        </div>
      </section>
    </div>
  );
}
