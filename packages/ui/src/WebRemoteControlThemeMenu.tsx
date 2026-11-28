import { Palette } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { useNibiStore } from "@/store/StoreProvider.js";
import { getThemeSwatchDotProps, type Theme } from "@/useTheme.js";

const MOBILE_THEME_OPTIONS: Theme[] = [
  "system",
  "nibi-light",
  "nibi-mist",
  "nibi-dark",
  "nibi-obsidian",
];

export function WebRemoteControlThemeMenu() {
  const { intl } = useNibiIntl();
  const theme = useNibiStore((state) => state.theme);
  const setTheme = useNibiStore((state) => state.setTheme);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={intl.formatMessage({ id: "webRemoteControl.themeMenu.trigger" })}
        >
          <Palette className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuRadioGroup
          value={theme}
          onValueChange={(value) => {
            if (MOBILE_THEME_OPTIONS.includes(value as Theme)) {
              setTheme(value as Theme);
            }
          }}
        >
          {MOBILE_THEME_OPTIONS.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              <span className="flex items-center gap-2">
                <span {...getThemeSwatchDotProps(option)} />
                {option === "system"
                  ? intl.formatMessage({ id: "sidebar.settings.systemDefault" })
                  : intl.formatMessage({ id: `sidebar.settings.theme.${option}` })}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
