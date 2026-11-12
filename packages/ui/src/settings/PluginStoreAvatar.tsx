import type { ReactNode } from "react";
import { PluginIcon } from "@/components/PluginIcon.js";
import type { StorePluginItem } from "@/settings/pluginStoreListing.js";

/**
 * 商店条目头像：listing.icon（仅 https）优先；缺失或加载失败时降级为**确定性字母头像**
 * （底色由插件 id/name 稳定映射到暖色调色板，见 lib/pluginAvatar），而不是空白/破图。
 * 与真实图标共用同一外层圆角方形与尺寸，加载失败不会发生形态或布局跳变。
 * 调用方仍可传 `fallbackIcon` 覆盖为资源类型图标（命令/Hook 等列表）。
 * 设计稿的图标资源只是图形本身，外层语义化容器负责主题背景；对整张图片
 * dark:invert 会把 Android 绿色等品牌色反相，因此这里保留资源原始颜色。
 */
export function PluginStoreAvatar({
  item,
  className,
  iconClassName,
  fallbackIcon,
  fallbackName,
}: {
  item: Pick<StorePluginItem, "name" | "listing"> & Partial<Pick<StorePluginItem, "id">>;
  className?: string;
  iconClassName?: string;
  fallbackIcon?: ReactNode;
  fallbackName?: string;
}) {
  return (
    <PluginIcon
      src={item.listing?.icon}
      pluginId={item.id}
      className={className}
      iconClassName={iconClassName}
      fallbackIcon={fallbackIcon}
      fallbackName={fallbackName?.trim() || item.listing?.displayName?.trim() || item.name}
    />
  );
}
