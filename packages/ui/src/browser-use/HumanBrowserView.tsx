import { useCallback, useEffect, useRef, type ComponentProps } from "react";
import {
  DEFAULT_AGENT_BROWSER_VIEWPORT,
  DEFAULT_EMBEDDED_BROWSER_VIEWPORT_PREFERENCE,
  type EmbeddedBrowserViewportPreference,
} from "@nibi/shared";
import { UnifiedBrowserView } from "@/browser-use/UnifiedBrowserView.js";
import type { HumanBrowserViewportPreferenceChangeSource } from "@/browser-use/useResponsiveBrowserViewportControl.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { recordBrowserRecentVisit } from "@/lib/browserRecentVisits.js";
import { logger } from "@/logger.js";

const HUMAN_BROWSER_VIEWPORT_PREFERENCE_WRITE_DELAY_MS = 200;

type HumanBrowserViewProps = Omit<
  ComponentProps<typeof UnifiedBrowserView>,
  "initialHumanViewportPreference" | "onHumanViewportPreferenceChange"
> & { agentOpened?: boolean };

function clonePreference(
  preference: EmbeddedBrowserViewportPreference,
): EmbeddedBrowserViewportPreference {
  return {
    ...preference,
    viewport: { ...preference.viewport },
  };
}

/** Browser 显示边界：普通 human tab 持久化偏好，Agent popup 使用独立默认 viewport。 */
export function HumanBrowserView(props: HumanBrowserViewProps): React.JSX.Element {
  const {
    agentOpened,
    onPageMetadataChange,
    onUrlChange,
    workspaceIdentity,
    workspaceKey,
    workspacePath,
    ...unifiedProps
  } = props;
  const { loading, settings, update } = useSettings();
  const initialPreferenceRef = useRef<EmbeddedBrowserViewportPreference | null>(null);
  const pendingPreferenceRef = useRef<EmbeddedBrowserViewportPreference | null>(null);
  const writeTimerRef = useRef<number | null>(null);
  const updateRef = useRef(update);
  updateRef.current = update;

  // 最近访问只在 human tab 记录；agent 打开的 tab 不进入用户浏览历史。
  const currentVisitUrlRef = useRef<string | null>(null);
  const pendingVisitMetadataRef = useRef<{
    title?: string;
    faviconUrl?: string | null;
  }>({});
  const visitFlushScheduledRef = useRef(false);
  const recentVisitWorkspaceKey =
    workspaceKey?.trim() || workspaceIdentity?.trim() || workspacePath?.trim() || "unscoped";

  const recordVisit = useCallback(
    (url: string, metadata: { title?: string; faviconUrl?: string | null }) => {
      recordBrowserRecentVisit({
        url,
        workspaceKey: recentVisitWorkspaceKey,
        ...(metadata.title === undefined ? {} : { title: metadata.title }),
        ...(metadata.faviconUrl === undefined ? {} : { faviconUrl: metadata.faviconUrl }),
      });
    },
    [recentVisitWorkspaceKey],
  );

  // syncBrowserState 先回传 title 再回传 URL；微任务让这两次同步回调落到同一个新 URL 上。
  const flushPendingVisitMetadata = useCallback(() => {
    if (visitFlushScheduledRef.current) return;
    visitFlushScheduledRef.current = true;
    queueMicrotask(() => {
      visitFlushScheduledRef.current = false;
      const metadata = pendingVisitMetadataRef.current;
      pendingVisitMetadataRef.current = {};
      const url = currentVisitUrlRef.current;
      if (url) recordVisit(url, metadata);
    });
  }, [recordVisit]);

  const handleHumanUrlChange = useCallback(
    (url: string) => {
      currentVisitUrlRef.current = url;
      const metadata = pendingVisitMetadataRef.current;
      pendingVisitMetadataRef.current = {};
      if (!agentOpened) recordVisit(url, metadata);
      onUrlChange?.(url);
    },
    [agentOpened, onUrlChange, recordVisit],
  );

  const handleHumanPageMetadataChange = useCallback(
    (metadata: { title?: string; faviconUrl?: string | null }) => {
      pendingVisitMetadataRef.current = {
        ...pendingVisitMetadataRef.current,
        ...(metadata.title === undefined ? {} : { title: metadata.title }),
        ...(metadata.faviconUrl === undefined ? {} : { faviconUrl: metadata.faviconUrl }),
      };
      if (!agentOpened) flushPendingVisitMetadata();
      onPageMetadataChange?.(metadata);
    },
    [agentOpened, flushPendingVisitMetadata, onPageMetadataChange],
  );

  if (!loading && !initialPreferenceRef.current) {
    initialPreferenceRef.current = clonePreference(
      agentOpened
        ? {
            mode: "responsive",
            viewport: { ...DEFAULT_AGENT_BROWSER_VIEWPORT },
            zoom: "fit",
          }
        : (settings?.embeddedBrowserViewportPreference ??
            DEFAULT_EMBEDDED_BROWSER_VIEWPORT_PREFERENCE),
    );
  }

  const commitPreference = useCallback((preference: EmbeddedBrowserViewportPreference) => {
    void updateRef
      .current({ embeddedBrowserViewportPreference: clonePreference(preference) })
      .catch((error) => {
        logger.warn("[browser] 保存人类浏览器显示偏好失败", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, []);

  const clearPendingWrite = useCallback(() => {
    if (writeTimerRef.current === null) return;
    window.clearTimeout(writeTimerRef.current);
    writeTimerRef.current = null;
  }, []);

  const handlePreferenceChange = useCallback(
    (
      preference: EmbeddedBrowserViewportPreference,
      source: HumanBrowserViewportPreferenceChangeSource,
    ) => {
      pendingPreferenceRef.current = clonePreference(preference);
      if (source === "viewport") {
        clearPendingWrite();
        // resize handle 每帧都会产生 CSS viewport；只合并 settings IO，不改变 guest 实时更新。
        writeTimerRef.current = window.setTimeout(() => {
          writeTimerRef.current = null;
          const pendingPreference = pendingPreferenceRef.current;
          pendingPreferenceRef.current = null;
          if (pendingPreference) commitPreference(pendingPreference);
        }, HUMAN_BROWSER_VIEWPORT_PREFERENCE_WRITE_DELAY_MS);
        return;
      }

      clearPendingWrite();
      const pendingPreference = pendingPreferenceRef.current;
      pendingPreferenceRef.current = null;
      if (pendingPreference) commitPreference(pendingPreference);
    },
    [clearPendingWrite, commitPreference],
  );

  useEffect(
    () => () => {
      clearPendingWrite();
      const pendingPreference = pendingPreferenceRef.current;
      pendingPreferenceRef.current = null;
      if (pendingPreference) commitPreference(pendingPreference);
    },
    [clearPendingWrite, commitPreference],
  );

  const initialPreference = initialPreferenceRef.current;
  if (!initialPreference) {
    return (
      <div
        aria-busy="true"
        data-browser-human-viewport-preference-state="loading"
        className="h-full min-h-0 w-full min-w-0 bg-background"
      />
    );
  }

  return (
    <UnifiedBrowserView
      {...unifiedProps}
      enableDesignMode={!agentOpened}
      enableRecentVisits={!agentOpened}
      initialHumanViewportPreference={initialPreference}
      onHumanViewportPreferenceChange={agentOpened ? undefined : handlePreferenceChange}
      onPageMetadataChange={agentOpened ? onPageMetadataChange : handleHumanPageMetadataChange}
      onUrlChange={agentOpened ? onUrlChange : handleHumanUrlChange}
      workspaceIdentity={workspaceIdentity}
      workspaceKey={workspaceKey}
      workspacePath={workspacePath}
    />
  );
}
