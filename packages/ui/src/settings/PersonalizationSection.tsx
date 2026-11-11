import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { RotateCw } from "lucide-react";
import {
  SETTINGS_SYNC_USER_AGENTS_FILE_MAX_BYTES,
  type SettingsSyncUserAgentsFile,
} from "@nibi/services";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { cn } from "@/components/lib/utils.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";

const MAX_KB = SETTINGS_SYNC_USER_AGENTS_FILE_MAX_BYTES / 1024;

/** 页面上限与字节统计共用同一套算法；KB 只做展示，保存门禁仍按原始字节。 */
export function formatAgentsFileKb(bytes: number): string {
  if (bytes <= 0) return "0";
  const kb = bytes / 1024;
  if (kb >= 10) return String(Math.ceil(kb));
  return kb.toFixed(1).replace(/\.0$/, "");
}

/**
 * 用户级 AGENTS.md 编辑器。
 * 作用域固定为本机 Host：远程设备的用户级 AGENTS.md 在各设备自己的设置里配置，
 * 这里即使从远端 workspace 打开设置页，也不能读写远端 Home。
 */
export function PersonalizationSection() {
  const { intl } = useZCodeIntl();
  const localHostServices = useBaseWorkspaceServices();
  const service = localHostServices.settingsSyncService;
  const editorId = useId();
  const descriptionId = useId();

  const [loaded, setLoaded] = useState<SettingsSyncUserAgentsFile | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadVersion = useRef(0);

  const load = useCallback(async () => {
    const version = ++loadVersion.current;
    setLoading(true);
    setError(null);
    try {
      const file = await service.readUserAgentsFile();
      if (loadVersion.current !== version) return;
      setLoaded(file);
      setDraft(file.content);
    } catch (cause) {
      if (loadVersion.current !== version) return;
      // 读取失败不能当成空文件：显示错误并保留重试，避免用户保存后覆盖原内容。
      logger.warn("[PersonalizationSection] 读取用户级 AGENTS.md 失败", {
        error: cause instanceof Error ? cause.message : String(cause),
      });
      setLoaded(null);
      setError(intl.formatMessage({ id: "settings.personalization.loadFailed" }));
    } finally {
      if (loadVersion.current === version) setLoading(false);
    }
  }, [intl, service]);

  useEffect(() => {
    void load();
    return () => {
      loadVersion.current += 1;
    };
  }, [load]);

  const bytes = useMemo(() => new TextEncoder().encode(draft).byteLength, [draft]);
  const overLimit = bytes > SETTINGS_SYNC_USER_AGENTS_FILE_MAX_BYTES;
  const dirty = loaded !== null && draft !== loaded.content;
  const canSave = loaded !== null && dirty && !overLimit && !loading && !saving;

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const result = await service.writeUserAgentsFile({ content: draft });
      setLoaded({ path: result.path, content: draft, exists: true });
      toast(intl.formatMessage({ id: "settings.personalization.saved" }));
    } catch (cause) {
      logger.warn("[PersonalizationSection] 保存用户级 AGENTS.md 失败", {
        error: cause instanceof Error ? cause.message : String(cause),
      });
      setError(intl.formatMessage({ id: "settings.personalization.saveFailed" }));
    } finally {
      setSaving(false);
    }
  }, [canSave, draft, intl, service]);

  const handleCancel = useCallback(() => {
    if (loaded) setDraft(loaded.content);
    setError(null);
  }, [loaded]);

  // 快捷键与保存按钮共用同一门禁；输入法组合期间不抢 Ctrl/Cmd+S。
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleSave();
      }
    },
    [handleSave],
  );

  const sizeLabel = intl.formatMessage(
    { id: "settings.personalization.size" },
    { used: formatAgentsFileKb(bytes), limit: String(MAX_KB) },
  );

  return (
    <section className="min-w-0 space-y-4" data-testid="settings-personalization">
      <p id={descriptionId} className="text-ui-base leading-6 text-foreground-subtle">
        {intl.formatMessage({ id: "settings.personalization.description" })}
      </p>
      <SettingsGroupCard>
        <div className="space-y-2 px-4 py-4">
          {loading ? (
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.personalization.loading" })}
            </p>
          ) : error && !loaded ? (
            <div className="space-y-3">
              <p role="alert" className="text-ui-base text-destructive">
                {error}
              </p>
              <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
                <RotateCw className="size-4" aria-hidden="true" />
                {intl.formatMessage({ id: "common.retry" })}
              </Button>
            </div>
          ) : (
            <>
              {/* 上游只在卡片里放大文本域；文件路径这类实现细节不再展示。 */}
              <SettingsFormTextarea
                id={editorId}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={handleKeyDown}
                disabled={saving}
                spellCheck={false}
                className="min-h-80 w-full font-mono"
                aria-label={intl.formatMessage({ id: "settings.personalization.editorLabel" })}
                aria-describedby={descriptionId}
                placeholder={intl.formatMessage({ id: "settings.personalization.placeholder" })}
                data-testid="settings-personalization-editor"
              />
              {/* 计数贴在文本域右下角；超限时用危险色，保持与文本域同一视觉组。 */}
              <div className="flex justify-end">
                <span
                  className={cn(
                    "text-ui-sm tabular-nums",
                    overLimit ? "text-destructive" : "text-foreground-subtle",
                  )}
                  data-testid="settings-personalization-size"
                >
                  {sizeLabel}
                </span>
              </div>
              {overLimit ? (
                <p role="alert" className="text-ui-base text-destructive">
                  {intl.formatMessage({ id: "settings.personalization.overLimit" })}
                </p>
              ) : null}
              {error ? (
                <p role="alert" className="text-ui-base text-destructive">
                  {error}
                </p>
              ) : null}
              <div className="flex items-center justify-end gap-2 pt-1">
                <Button
                  type="button"
                  size="sm"
                  disabled={!canSave}
                  onClick={() => void handleSave()}
                  data-testid="settings-personalization-save"
                >
                  {intl.formatMessage({ id: "common.save" })}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={saving || !dirty}
                  onClick={handleCancel}
                  data-testid="settings-personalization-cancel"
                >
                  {intl.formatMessage({ id: "common.cancel" })}
                </Button>
              </div>
            </>
          )}
        </div>
      </SettingsGroupCard>
    </section>
  );
}
