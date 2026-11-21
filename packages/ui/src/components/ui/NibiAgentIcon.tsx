import type { ImgHTMLAttributes } from "react";
import nibiBirdIcon from "@/assets/nibi/nibi-bird.png";
import { cn } from "@/components/lib/utils.js";
import { useNibiStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";

type NibiAgentIconProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src">;

/** NIBI Agent 的统一标识：使用 NIBI 纸质小鸟，按主题压成单色。 */
export function NibiAgentIcon({ className, alt = "", style, ...props }: NibiAgentIconProps) {
  const theme = useNibiStore((state) => state.theme);
  const isDark = resolveTheme(theme) === "dark";
  const filter = isDark
    ? "grayscale(1) brightness(1.2) contrast(1.1)"
    : "grayscale(1) brightness(0.74) contrast(1.05)";

  return (
    <img
      src={nibiBirdIcon}
      alt={alt}
      aria-hidden={alt ? undefined : true}
      className={cn("shrink-0 object-contain", className)}
      style={{ filter, ...style }}
      {...props}
    />
  );
}
