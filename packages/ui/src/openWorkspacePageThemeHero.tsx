import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { resolveTheme } from "@/useTheme.js";
import type { Theme } from "@/useTheme.js";
import nibiPerchedUrl from "@/assets/nibi/nibi-perched.png";
import featherOrangeUrl from "@/assets/nibi/feather-orange.png";
import featherPurpleUrl from "@/assets/nibi/feather-purple.png";
import featherSageUrl from "@/assets/nibi/feather-sage.png";

interface ThemeHeroPalette {
  isDark: boolean;
  panel: string;
  meshBase: string;
  meshLight: string;
  glowPrimary: string;
  glowSecondary: string;
  heading: string;
  description: string;
}

function getThemeHeroPalette(theme: Theme): ThemeHeroPalette {
  switch (theme) {
    case "nibi-dark":
    case "dark":
    case "system":
    default:
      return {
        isDark: true,
        meshBase: "#171716",
        meshLight: "#e8c491",
        panel:
          "bg-[linear-gradient(180deg,#1b1b1c_0%,#171716_48%,#131313_100%)] before:absolute before:inset-0 before:content-[''] before:bg-[radial-gradient(circle_at_18%_18%,rgba(238,240,242,0.05),transparent_30%),radial-gradient(circle_at_82%_14%,rgba(207,168,126,0.1),transparent_34%),radial-gradient(circle_at_68%_84%,rgba(235,154,82,0.08),transparent_36%)]",
        glowPrimary: "bg-[#e8c491]/10 mix-blend-screen",
        glowSecondary: "bg-[#d97e6e]/8 mix-blend-screen",
        heading: "text-[#eef0f2]",
        description: "text-[#9aa0a8]",
      };
    case "nibi-light":
    case "light":
      return {
        isDark: false,
        meshBase: "#f9f2e4",
        meshLight: "#e08a3e",
        panel:
          "bg-[linear-gradient(180deg,#fdf9f0_0%,#f9f2e4_46%,#f3ead8_100%)] before:absolute before:inset-0 before:content-[''] before:bg-[radial-gradient(circle_at_18%_16%,rgba(255,253,247,0.95),transparent_30%),radial-gradient(circle_at_84%_12%,rgba(74,121,184,0.13),transparent_32%),radial-gradient(circle_at_70%_88%,rgba(224,138,62,0.11),transparent_36%)]",
        glowPrimary: "bg-[#e08a3e]/14 mix-blend-multiply",
        glowSecondary: "bg-[#4a79b8]/12 mix-blend-multiply",
        heading: "text-[#142d52]",
        description: "text-[#5d6c84]",
      };
  }
}

export function useResolvedThemeHeroPalette(): ThemeHeroPalette {
  const theme = useZCodeStore((state) => state.theme);
  const resolvedTheme =
    theme === "system" ? (resolveTheme(theme) === "dark" ? "dark" : "light") : theme;

  return getThemeHeroPalette(resolvedTheme);
}

function HeroCreature({ isDark }: { isDark: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn("nibi-hero-creature", isDark && "nibi-hero-creature--dark")}
    >
      <img
        src={nibiPerchedUrl}
        alt=""
        draggable={false}
        className="nibi-hero-perched"
      />
      <img
        src={featherOrangeUrl}
        alt=""
        draggable={false}
        className="nibi-hero-feather nibi-hero-feather--orange"
      />
      <img
        src={featherPurpleUrl}
        alt=""
        draggable={false}
        className="nibi-hero-feather nibi-hero-feather--purple"
      />
      <img
        src={featherSageUrl}
        alt=""
        draggable={false}
        className="nibi-hero-feather nibi-hero-feather--sage"
      />
    </div>
  );
}

export function ThemeHeroVisual(props: {
  className?: string;
  contentClassName?: string;
  children?: ReactNode;
  showBird?: boolean;
}) {
  const palette = useResolvedThemeHeroPalette();

  return (
    <div className={cn("relative overflow-hidden", palette.panel, props.className)}>
      <div
        className={cn(
          "pointer-events-none absolute left-[-12%] top-[18%] h-[42rem] w-[42rem] rounded-full blur-3xl",
          palette.glowPrimary,
        )}
      />
      <div
        className={cn(
          "pointer-events-none absolute right-[-18%] bottom-[-14%] h-[36rem] w-[36rem] rounded-full blur-3xl",
          palette.glowSecondary,
        )}
      />
      {props.showBird ? <HeroCreature isDark={palette.isDark} /> : null}
      {props.children ? (
        <div className={cn("relative z-10", props.contentClassName)}>{props.children}</div>
      ) : null}
    </div>
  );
}
