import { Card, CardContent } from "@/components/ui/card.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Switch } from "@/components/ui/switch.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  setCompanionPreference,
  useCompanionPreferences,
  type CompanionAnimationMode,
  type CompanionMode,
} from "@/companion/companionPreferences.js";

const MODES: CompanionMode[] = ["auto", "perch", "working", "complete", "paused"];

/** 外观 › 小鸟伴侣：与「界面动效」同款行式布局，使用设置页现成控件。 */
export function CompanionSettingsRows() {
  const { intl } = useZCodeIntl();
  const preferences = useCompanionPreferences();

  return (
    <div className="min-w-0 space-y-3">
      <div>
        <h3 className="text-ui-lg font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.companion.title" })}
        </h3>
        <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">
          {intl.formatMessage({ id: "settings.companion.description" })}
        </p>
      </div>
      <Card className="border border-border bg-card py-0 shadow-none">
        <CardContent className="space-y-0 px-0">
          <SettingsRow
            label={intl.formatMessage({ id: "settings.companion.visible" })}
            description={intl.formatMessage({
              id: "settings.companion.visibleDescription",
            })}
            control={
              <Switch
                checked={preferences.visible}
                onCheckedChange={(checked) => setCompanionPreference("visible", checked)}
              />
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "settings.companion.mode" })}
            description={intl.formatMessage({
              id: "settings.companion.modeDescription",
            })}
            control={
              <Select
                value={preferences.mode}
                onValueChange={(value) =>
                  setCompanionPreference("mode", value as CompanionMode)
                }
              >
                <SelectTrigger size="lg" className="w-[260px] min-w-0 justify-between">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MODES.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {intl.formatMessage({ id: `settings.companion.mode.${mode}` })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "settings.companion.follow" })}
            description={intl.formatMessage({
              id: "settings.companion.followDescription",
            })}
            control={
              <Switch
                checked={preferences.follow}
                onCheckedChange={(checked) => setCompanionPreference("follow", checked)}
              />
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "settings.companion.feathers" })}
            description={intl.formatMessage({
              id: "settings.companion.feathersDescription",
            })}
            control={
              <Switch
                checked={preferences.feathers}
                onCheckedChange={(checked) => setCompanionPreference("feathers", checked)}
              />
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "settings.companion.animation" })}
            description={intl.formatMessage({
              id: "settings.companion.animationDescription",
            })}
            control={
              <Select
                value={preferences.animation}
                onValueChange={(value) =>
                  setCompanionPreference("animation", value as CompanionAnimationMode)
                }
              >
                <SelectTrigger size="lg" className="w-[260px] min-w-0 justify-between">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="inherit">
                    {intl.formatMessage({ id: "settings.companion.animationInherit" })}
                  </SelectItem>
                  <SelectItem value="independent">
                    {intl.formatMessage({ id: "settings.companion.animationIndependent" })}
                  </SelectItem>
                  <SelectItem value="off">
                    {intl.formatMessage({ id: "settings.companion.animationOff" })}
                  </SelectItem>
                </SelectContent>
              </Select>
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
