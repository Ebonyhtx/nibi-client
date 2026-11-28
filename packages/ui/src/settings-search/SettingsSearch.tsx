import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import type { SettingsSectionDefinition } from "@/settings/settingsPageConfig.js";
import {
  createSettingsSearchIndex,
  searchSettingsIndex,
  type SettingsSearchIndexEntry,
} from "@/settings-search/settingsSearchIndex.js";

const RESULTS_ID = "settings-search-results";

export function SettingsSearch({
  settingsSections,
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
  isLinuxDesktop = false,
  onNavigate,
}: {
  settingsSections: readonly SettingsSectionDefinition[];
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  isLinuxDesktop?: boolean;
  onNavigate: (entry: SettingsSearchIndexEntry) => void;
}) {
  const { intl } = useNibiIntl();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [narrowOpen, setNarrowOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const index = useMemo(
    () =>
      createSettingsSearchIndex({
        settingsSections,
        isDesktop,
        isMacDesktop,
        isWindowsDesktop,
        isLinuxDesktop,
        translate: (id) => intl.formatMessage({ id }),
      }),
    [intl, isDesktop, isLinuxDesktop, isMacDesktop, isWindowsDesktop, settingsSections],
  );
  const results = useMemo(() => searchSettingsIndex(index, query), [index, query]);
  const showResults = query.trim().length > 0;

  useEffect(() => {
    setActiveIndex(results.length > 0 ? 0 : -1);
  }, [results]);

  // 窄屏用图标按钮打开浮层；浮层出现后把焦点送进输入框。
  useEffect(() => {
    if (!narrowOpen) return;
    containerRef.current?.querySelector<HTMLInputElement>("input")?.focus();
  }, [narrowOpen]);

  // 点空白处收起结果/浮层，但不吞掉输入框内部的点击。
  useEffect(() => {
    if (!showResults && !narrowOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return;
      setQuery("");
      setNarrowOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [narrowOpen, showResults]);

  const commit = (entry: SettingsSearchIndexEntry) => {
    setQuery("");
    setNarrowOpen(false);
    onNavigate(entry);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (query) {
        setQuery("");
      } else {
        setNarrowOpen(false);
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (results.length === 0) return;
      setActiveIndex((current) => (current + 1) % results.length);
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      if (results.length === 0) return;
      setActiveIndex((current) => (current <= 0 ? results.length - 1 : current - 1));
      return;
    }

    if (event.key === "Enter") {
      const entry = results[Math.max(activeIndex, 0)];
      if (!entry) return;
      event.preventDefault();
      commit(entry);
    }
  };

  return (
    <div ref={containerRef} data-testid="settings-search" className="relative min-w-0">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={intl.formatMessage({ id: "settings.search.open" })}
        data-testid="settings-search-open"
        className="mx-auto flex size-9 rounded-xl text-foreground-subtle hover:text-foreground lg:hidden"
        onClick={() => setNarrowOpen(true)}
      >
        <Search className="size-4" aria-hidden="true" />
      </Button>

      <div
        className={cn(
          "relative min-w-0",
          narrowOpen
            ? "max-lg:fixed max-lg:inset-x-2 max-lg:top-14 max-lg:z-50 max-lg:mx-auto max-lg:max-w-sm max-lg:rounded-xl max-lg:border max-lg:border-border max-lg:bg-background max-lg:p-2 max-lg:shadow-lg"
            : "max-lg:hidden",
        )}
      >
        <SettingsSearchInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          onClear={() => setQuery("")}
          clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
          clearTestId="settings-search-clear"
          placeholder={intl.formatMessage({ id: "settings.search.placeholder" })}
          aria-label={intl.formatMessage({ id: "settings.search.label" })}
          aria-autocomplete="list"
          aria-controls={showResults ? RESULTS_ID : undefined}
          aria-expanded={showResults}
          data-testid="settings-search-input"
        />

        {showResults ? (
          <div
            id={RESULTS_ID}
            role="listbox"
            aria-label={intl.formatMessage({ id: "settings.search.resultsLabel" })}
            data-testid="settings-search-results"
            className="absolute inset-x-0 top-full z-50 mt-1 max-h-80 overflow-y-auto rounded-xl border border-popover-border bg-menu/96 p-1 shadow-[var(--nibi-shadow-popover)] supports-[backdrop-filter]:backdrop-blur-lg"
          >
            {results.length === 0 ? (
              <p
                className="px-3 py-6 text-center text-ui-sm text-foreground-subtle"
                data-testid="settings-search-no-results"
              >
                {intl.formatMessage({ id: "settings.search.noResults" })}
              </p>
            ) : (
              <ul className="min-w-0">
                {results.map((entry, resultIndex) => {
                  const active = resultIndex === activeIndex;
                  return (
                    <li key={entry.id} className="min-w-0">
                      <button
                        type="button"
                        role="option"
                        aria-selected={active}
                        data-testid="settings-search-result"
                        data-settings-search-result-id={entry.id}
                        className={cn(
                          "flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors",
                          active ? "bg-surface-hover" : "hover:bg-surface-hover",
                        )}
                        onMouseDown={(event) => event.preventDefault()}
                        onMouseEnter={() => setActiveIndex(resultIndex)}
                        onClick={() => commit(entry)}
                      >
                        <span className="min-w-0 flex-1 truncate text-ui-base text-foreground">
                          {entry.title}
                        </span>
                        <span className="shrink-0 text-ui-sm text-foreground-subtle">
                          {entry.sectionTitle}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}