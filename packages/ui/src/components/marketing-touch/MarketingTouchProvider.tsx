import { createContext, useContext, useEffect, useCallback, useState } from "react";
import type { ReactNode } from "react";
import { useStore } from "zustand";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";
import { setPendingSettingsSectionIntent } from "@/lib/settingsNavigation.js";
import { requestPluginStoreOpen } from "@/lib/pluginStoreNavigation.js";
import {
  requestMarketingNavigation,
  marketingSettingsSections,
  waitForMarketingCapability,
} from "@/lib/marketingNavigation.js";
import { NIBI_ENV } from "@nibi/shared";
import { useServices } from "@/hooks/useServices.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCloudHeroEnvironment } from "@/components/cloud-content-dialog/useCloudHeroEnvironment.js";
import { MarketingDialogs } from "@/components/marketing-touch/MarketingDialogs.js";
import { toast } from "@/components/ui/toast.js";
import { logger } from "@/logger.js";
import { MarketingBannerView } from "@/components/marketing-touch/MarketingBanner.js";
import {
  canOpenMarketingPopup,
  marketingLabel,
} from "@/components/marketing-touch/marketingPopupAdapter.js";
import {
  createMarketingTouchController,
  isMarketingBannerRenderable,
  type MarketingTouchController,
} from "@/components/marketing-touch/marketingTouchController.js";
import {
  createMarketingTouchPoller,
  resolveMarketingTouchPollIntervalMs,
} from "@/components/marketing-touch/marketingTouchPoller.js";
import { prepareMarketingHero } from "@/components/marketing-touch/marketingResources.js";

import { MarketingRefreshContext } from "@/components/marketing-touch/useMarketingTaskCompletionRefresh.js";

const Context = createContext<MarketingTouchController | null>(null);

// 导出给左下角活动仲裁层（SidebarBottomActivity）读取 Banner 可见性；控制器仍是唯一 owner。
export { Context as MarketingTouchContext };

export function MarketingTouchProvider({
  children,
  desktop,
}: {
  children: ReactNode;
  desktop: boolean;
}) {
  const services = useServices();
  const platform = usePlatform();
  const openSettingsTab = useTabStore((state) => state.openSettingsTab);
  const tabStore = useTabStoreApi();
  const user = useZCodeStore((state) => state.user);
  const restoring = useZCodeStore((state) => state.isRestoringOAuthSession);
  const requestLogin = useZCodeStore((state) => state.requestLoginEntry);
  const { intl, locale } = useZCodeIntl();
  const identity = user?.id ?? "anonymous";
  const createRuntime = useCallback(() => {
    const service = services.marketingTouchService;
    if (!service || restoring) return null;
    let poller: ReturnType<typeof createMarketingTouchPoller>;
    const controller = createMarketingTouchController({
      query: () => service.query({ locale }),
      report: (input) => service.report(input),
      locale,
      canOpen: canOpenMarketingPopup,
      refresh: () => poller.refresh(),
      prepare: async (delivery) => {
        const assets = services.cloudContentService;
        const visual =
          delivery.resource_position === "banner"
            ? delivery.banner.success_popup?.hero
            : delivery.popup.hero;
        const success = prepareMarketingHero(visual, assets, locale, desktop);
        const background =
          delivery.resource_position === "banner"
            ? prepareMarketingHero(delivery.banner.background, assets, locale, desktop)
            : undefined;
        let released = false;
        const release = async () => {
          if (!released) {
            released = true;
            await Promise.all([
              (async () => (await success).release())(),
              (async () => (await background)?.release())(),
            ]);
          }
        };
        if (delivery.resource_position === "banner") {
          try {
            if (!assets) throw new Error("marketing_resources_unavailable");
            const prepared = (await background)?.hero;
            if (!prepared) throw new Error("marketing_banner_unavailable");
            return {
              delivery,
              image: prepared.type === "image" ? prepared.src : undefined,
              darkImage: prepared.type === "image" ? prepared.darkSrc : undefined,
              bannerHero:
                prepared.type === "interactive_bundle" || prepared.type === "video"
                  ? prepared
                  : undefined,
              hero: null,
              success,
              release,
            };
          } catch (error) {
            void release();
            throw error;
          }
        }
        const prepared = await success;
        return { delivery, hero: prepared.hero, release };
      },
      execute: async (action, signal, phase) => {
        if (action.type === "close") return { status: "cancelled" };
        if (action.type === "navigate" || action.type === "copy_text") {
          try {
            signal.throwIfAborted();
            phase("submitting");
            if (action.type === "copy_text") {
              await waitForMarketingCapability(
                navigator.clipboard.writeText(action.args.text),
                signal,
                10_000,
              );
              signal.throwIfAborted();
              if (!controller.store.getState().dialog)
                toast(intl.formatMessage({ id: "manualClaimPlan.claim.share.copyTextSucceeded" }));
            } else if (action.args.page === "rewards") {
              // 「邀请好友」是上游的 rewards 页面（zcode.z.ai），NIBI 不提供，已移除入口与 Provider。
              // 服务端若仍下发这条导航，这里 fail-closed：不打开别家站点，只如实记一条。
              logger.warn("[marketing-touch] rewards 页面在 NIBI 中不可用，已忽略该导航");
              return { status: "cancelled" };
            } else {
              const opening = new AbortController();
              const abortOpening = () => opening.abort();
              signal.addEventListener("abort", abortOpening, { once: true });
              try {
                await requestMarketingNavigation(action.args, signal, () => {
                  if (action.args.page === "upgrade") {
                    // 上游 Coding Plan 升级入口已下线：不打开别家购买页。
                    logger.warn("[marketing-touch] upgrade 页面在 NIBI 中不可用，已忽略该导航");
                    throw new Error("marketing_upgrade_unavailable");
                  }
                  if (action.args.page === "settings") {
                    if (action.args.section)
                      setPendingSettingsSectionIntent(
                        marketingSettingsSections[action.args.section],
                        { modelProviderId: action.args.provider_id },
                      );
                    openSettingsTab();
                  } else if (action.args.page === "plugin_marketplace") {
                    const tabs = tabStore.getState();
                    if (!tabs.activeWorkspacePath)
                      throw new Error("marketing_navigation_unavailable");
                    requestPluginStoreOpen(action.args.plugin_id);
                    // 市场在工作区内；仅发事件会在设置层后挂载，必须退出设置并激活原工作区。
                    if (
                      !tabs.activateTabByPath(tabs.activeWorkspacePath, {
                        workspaceIdentity: tabs.activeWorkspaceIdentity ?? undefined,
                      })
                    )
                      throw new Error("marketing_navigation_unavailable");
                  }
                });
              } finally {
                signal.removeEventListener("abort", abortOpening);
                opening.abort();
              }
            }
            return { status: "success" };
          } catch (error) {
            const timedOut =
              error instanceof Error && error.message === "marketing_capability_timeout";
            if (!signal.aborted)
              logger.warn("[marketing-touch] capability failed", {
                action: action.type,
                reason: timedOut ? "timeout" : "unavailable",
              });
            return {
              status: signal.aborted ? "cancelled" : timedOut ? "uncertain" : "failure",
              message: intl.formatMessage({
                id: timedOut ? "marketingTouch.uncertain" : "marketingTouch.failed",
              }),
            };
          }
        }
        if (action.type === "open_url") {
          try {
            await platform.openExternal(action.args.url);
            return { status: "success" };
          } catch {
            return {
              status: "failure",
              message: intl.formatMessage({ id: "marketingTouch.failed" }),
            };
          }
        }
        if (!user) {
          requestLogin();
          return { status: "cancelled" };
        }
        // NIBI 不提供上游套餐领取；服务端若仍下发 claim 动作，fail-closed。
        logger.warn("[marketing-touch] claim_zcode_plan 在 NIBI 中不可用，已忽略该动作");
        return { status: "cancelled" };
      },
    });
    poller = createMarketingTouchPoller({
      intervalMs: resolveMarketingTouchPollIntervalMs(import.meta.env.PROD, NIBI_ENV),
      query: async () => {
        await controller.refresh();
        await controller.showPending();
      },
      visible: () => document.visibilityState !== "hidden",
    });
    return { controller, poller };
  }, [
    services,
    platform,
    identity,
    Boolean(user),
    restoring,
    locale,
    intl,
    requestLogin,
    desktop,
    openSettingsTab,
    tabStore,
  ]);
  const [runtime, setRuntime] = useState<ReturnType<typeof createRuntime>>(null);
  useEffect(() => {
    const runtime = createRuntime();
    setRuntime(runtime);
    if (!runtime) return;
    const { controller, poller } = runtime;
    const visibility = () => {
      poller.visibilityChanged();
      void controller.showPending();
    };
    const online = () => poller.refresh();
    const observer = new MutationObserver(() => {
      void controller.showPending().catch(() => {});
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", online);
    poller.refresh();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", online);
      poller.dispose();
      controller.dispose();
    };
  }, [createRuntime]);
  return (
    <Context.Provider value={runtime?.controller ?? null}>
      <MarketingRefreshContext.Provider value={runtime?.poller.refresh ?? null}>
        {children}
      </MarketingRefreshContext.Provider>
      {runtime ? <MarketingDialogs controller={runtime.controller} /> : null}
    </Context.Provider>
  );
}

export function MarketingBanner() {
  const controller = useContext(Context);
  return controller ? <ConnectedBanner controller={controller} /> : null;
}
function ConnectedBanner({ controller }: { controller: MarketingTouchController }) {
  const state = useStore(controller.store);
  const { dark } = useCloudHeroEnvironment();
  const { intl, locale } = useZCodeIntl();
  const banner = state.banner;
  // 与仲裁层（SidebarBottomActivity）共用同一可见性谓词，避免两处判断漂移。
  if (!isMarketingBannerRenderable(banner)) return null;
  const buttons = banner.delivery.banner.buttons;
  const action = buttons.find((button) => button.action.type !== "close");
  const close = buttons.find((button) => button.action.type === "close");
  return (
    <MarketingBannerView
      src={dark && banner.darkImage ? banner.darkImage : banner.image}
      bundle={banner.bannerHero?.type === "interactive_bundle" ? banner.bannerHero : undefined}
      video={banner.bannerHero?.type === "video" ? banner.bannerHero : undefined}
      locale={locale}
      // 纯图片 Banner 允许空文案；动作是否存在不能由标签决定。
      hasAction={Boolean(action)}
      hasClose={Boolean(close)}
      actionLabel={
        (action && marketingLabel(action.text).trim()) || intl.formatMessage({ id: "common.open" })
      }
      closeLabel={
        (close && marketingLabel(close.text).trim()) || intl.formatMessage({ id: "common.close" })
      }
      pending={state.pending}
      pendingLabel={intl.formatMessage({ id: `marketingTouch.${state.phase}` })}
      onClick={() => {
        void controller.clickBanner().catch(() => logger.warn("[marketing-touch] action failed"));
      }}
      onClose={() => {
        void controller.closeBanner();
      }}
    />
  );
}
