import { MarketingBanner } from "@/components/marketing-touch/MarketingTouchProvider.js";
import { useMarketingBannerVisible } from "@/components/marketing-touch/useMarketingBannerVisible.js";

/**
 * 左下角活动共享槽位：领 token banner 可见时独占槽位。
 * 不可见时不产生多余 DOM。
 */
export function SidebarBottomActivity() {
  const bannerVisible = useMarketingBannerVisible();
  if (!bannerVisible) return null;
  return <MarketingBanner />;
}
