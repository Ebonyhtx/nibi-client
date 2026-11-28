import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";
import { useNibiStore } from "@/store/StoreProvider.js";
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
    case "nibi-obsidian":
      return {
        isDark: true,
        meshBase: "#0a0d12",
        meshLight: "#5ec2b6",
        panel:
          "bg-[linear-gradient(180deg,#151b25_0%,#11161e_48%,#0a0d12_100%)] before:absolute before:inset-0 before:content-[''] before:bg-[radial-gradient(circle_at_18%_18%,rgba(228,235,243,0.06),transparent_32%),radial-gradient(circle_at_82%_14%,rgba(94,194,182,0.12),transparent_36%),radial-gradient(circle_at_68%_84%,rgba(140,164,190,0.08),transparent_36%)]",
        glowPrimary: "bg-[#5ec2b6]/14 mix-blend-screen",
        glowSecondary: "bg-[#8ca4be]/10 mix-blend-screen",
        heading: "text-[#e4ebf3]",
        description: "text-[#8ca4be]",
      };
    case "nibi-dark":
    case "dark":
    case "system":
    default:
      return {
        isDark: true,
        meshBase: "#100f0d",
        meshLight: "#e6c28e",
        panel:
          "bg-[linear-gradient(180deg,#1d1b18_0%,#181714_48%,#100f0d_100%)] before:absolute before:inset-0 before:content-[''] before:bg-[radial-gradient(circle_at_18%_18%,rgba(243,234,216,0.05),transparent_30%),radial-gradient(circle_at_82%_14%,rgba(230,194,142,0.11),transparent_34%),radial-gradient(circle_at_68%_84%,rgba(201,162,118,0.08),transparent_36%)]",
        glowPrimary: "bg-[#e6c28e]/12 mix-blend-screen",
        glowSecondary: "bg-[#d97e6e]/8 mix-blend-screen",
        heading: "text-[#e6e0d6]",
        description: "text-[#9c9284]",
      };
    case "nibi-mist":
      return {
        isDark: false,
        meshBase: "#e8ebef",
        meshLight: "#266161",
        panel:
          "bg-[linear-gradient(180deg,#ffffff_0%,#fafbfc_48%,#e8ebef_100%)] before:absolute before:inset-0 before:content-[''] before:bg-[radial-gradient(circle_at_18%_16%,rgba(255,255,255,0.96),transparent_30%),radial-gradient(circle_at_84%_12%,rgba(38,97,97,0.1),transparent_32%),radial-gradient(circle_at_70%_88%,rgba(82,109,122,0.08),transparent_36%)]",
        glowPrimary: "bg-[#266161]/10 mix-blend-multiply",
        glowSecondary: "bg-[#526d7a]/8 mix-blend-multiply",
        heading: "text-[#171c24]",
        description: "text-[#526d7a]",
      };
    case "nibi-light":
    case "light":
      return {
        isDark: false,
        meshBase: "#efe6d5",
        meshLight: "#a85014",
        panel:
          "bg-[linear-gradient(180deg,#fffefa_0%,#fcf9f2_48%,#efe6d5_100%)] before:absolute before:inset-0 before:content-[''] before:bg-[radial-gradient(circle_at_18%_16%,rgba(255,254,250,0.95),transparent_30%),radial-gradient(circle_at_84%_12%,rgba(56,98,153,0.12),transparent_32%),radial-gradient(circle_at_70%_88%,rgba(168,80,20,0.11),transparent_36%)]",
        glowPrimary: "bg-[#a85014]/12 mix-blend-multiply",
        glowSecondary: "bg-[#386299]/10 mix-blend-multiply",
        heading: "text-[#1c2b42]",
        description: "text-[#56647a]",
      };
  }
}

export function useResolvedThemeHeroPalette(): ThemeHeroPalette {
  const theme = useNibiStore((state) => state.theme);
  const resolvedTheme =
    theme === "system" ? (resolveTheme(theme) === "dark" ? "dark" : "light") : theme;

  return getThemeHeroPalette(resolvedTheme);
}

function HeroCreature({
  isDark,
  showBird,
  showFeathers,
}: {
  isDark: boolean;
  showBird: boolean;
  showFeathers: boolean;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn("nibi-hero-creature", isDark && "nibi-hero-creature--dark")}
    >
      {showBird ? (
        <img
          src={nibiPerchedUrl}
          alt=""
          draggable={false}
          className="nibi-hero-perched"
        />
      ) : null}
      {showFeathers ? (
        <>
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
        </>
      ) : null}
    </div>
  );
}

export function ThemeHeroVisual(props: {
  className?: string;
  contentClassName?: string;
  children?: ReactNode;
  showBird?: boolean;
  showFeathers?: boolean;
}) {
  const palette = useResolvedThemeHeroPalette();
  const showBird = Boolean(props.showBird);
  const showFeathers = props.showFeathers ?? showBird;

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
      {showBird || showFeathers ? (
        <HeroCreature isDark={palette.isDark} showBird={showBird} showFeathers={showFeathers} />
      ) : null}
      {props.children ? (
        <div className={cn("relative z-10", props.contentClassName)}>{props.children}</div>
      ) : null}
    </div>
  );
}
