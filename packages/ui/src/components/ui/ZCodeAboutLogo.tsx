import { cn } from "@/components/lib/utils.js";

import nibiAppIconUrl from "@/assets/nibi/nibi-app-icon.png";

/** 关于框与首屏共用的品牌标记：NIBI 应用图标（自带圆角与底色）。 */
export function ZCodeAboutLogo({ className }: { className?: string }) {
  return (
    <img
      src={nibiAppIconUrl}
      alt="NIBI"
      aria-hidden="true"
      draggable={false}
      className={cn("shrink-0 select-none rounded-lg", className)}
    />
  );
}
