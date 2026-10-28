import type { NibiAppLogoProps } from "@/components/mobile-ui/contract.js";
import { cn } from "@/components/lib/utils.js";
import appLogoUrl from "@/assets/nibi/nibi-app-icon.png";

/**
 * NIBI 应用图标（圆角方块 + 鸟头，自带底色，深浅主题通用），与桌面端/手机端一致。
 * 装饰性图片：调用方负责在旁边给出可读的品牌文字，避免屏幕阅读器重复朗读。
 * data-app-logo 的取值是既有的测试钩子，不代表品牌。
 */
export function NibiAppLogo({ className }: NibiAppLogoProps) {
  return (
    <img
      src={appLogoUrl}
      alt=""
      aria-hidden="true"
      draggable={false}
      // 稳定的测试/E2E 钩子：打包器可能把 SVG 内联为 data URL，不能靠文件名断言。
      data-app-logo="zcode"
      className={cn("shrink-0 select-none object-contain", className)}
    />
  );
}
