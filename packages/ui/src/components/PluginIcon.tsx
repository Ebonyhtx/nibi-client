import { useEffect, useState, type ReactNode } from "react";
import { Blocks } from "lucide-react";
import { nibiMirrorUrlForContent } from "@nibi/shared";
import { cn } from "@/components/lib/utils.js";
import { pluginAvatarInitial, pluginAvatarSeed, pluginAvatarTone } from "@/lib/pluginAvatar.js";
import { resolvePluginIconSource } from "@/lib/pluginIconSource.js";

type PluginIconStage = "primary" | "mirror" | "retry" | "failed";

/**
 * Plugin 原始图标；支持官方内置图标与 HTTPS，缺失或失败时使用调用方兜底，默认回退 Blocks。
 *
 * 加载顺序：主源 → **国内镜像**（仅我们的内容主机）→ 主源重试一次 → 兜底。
 * 这条兜底规则与清单/zip/配置的「主源失败退镜像」是同一条（见 shared/nibiContentMirror），
 * 区别只是这里发生在渲染进程的 `<img>` 上：主源被线路阻断时图标不该整片变成默认图标。
 * 镜像用自签证书，渲染 session 对镜像主机的证书信任由主进程单独放行（desktopNetworkPolicy）。
 *
 * 兜底优先级：调用方显式 `fallbackIcon`（资源类型图标）→ `fallbackName` 的确定性字母头像
 * → 中性 Blocks。字母头像的底色只由插件 id/name 决定（见 lib/pluginAvatar），不会随刷新变色。
 * 重试有界（最多一次），失败后直接落到兜底，不打印控制台错误，也不留空白容器。
 */
export function PluginIcon({
  src,
  pluginId,
  className,
  iconClassName,
  fallbackIcon,
  fallbackName,
}: {
  src?: string;
  pluginId?: string;
  className?: string;
  iconClassName?: string;
  fallbackIcon?: ReactNode;
  /** 无图标/加载失败时用于字母头像的显示名（传了才启用字母头像）。 */
  fallbackName?: string;
}) {
  const primarySrc = resolvePluginIconSource(pluginId, src);
  const mirrorCandidate = primarySrc ? nibiMirrorUrlForContent(primarySrc) : null;
  // 镜像与主源相同时不把同一次失败当成「换源成功」，直接进入重试阶段。
  const mirrorSrc = mirrorCandidate && mirrorCandidate !== primarySrc ? mirrorCandidate : null;
  const [stage, setStage] = useState<PluginIconStage>("primary");

  // 换图标（切换插件/商店刷新）时重新从主源开始，不能沿用上一个地址的失败状态。
  useEffect(() => {
    setStage("primary");
  }, [primarySrc]);

  const resolvedSrc =
    stage === "primary" || stage === "retry"
      ? primarySrc
      : stage === "mirror"
        ? (mirrorSrc ?? undefined)
        : undefined;
  const showImage = Boolean(resolvedSrc);
  const showInitial = !showImage && !fallbackIcon && Boolean(fallbackName?.trim());
  const tone = showInitial
    ? pluginAvatarTone(pluginAvatarSeed({ id: pluginId, name: fallbackName }))
    : undefined;

  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 select-none items-center justify-center overflow-hidden rounded-xl bg-surface",
        !showImage && "text-foreground-subtle",
        className,
      )}
      // 字母头像用容器宽度决定字号（42cqw），任何尺寸（size-5…size-16）都不会溢出或跳变。
      style={
        tone
          ? {
              backgroundColor: tone.background,
              color: tone.foreground,
              containerType: "inline-size",
            }
          : undefined
      }
    >
      {showImage ? (
        <img
          key={stage}
          src={resolvedSrc}
          alt=""
          draggable={false}
          className="size-full object-contain"
          onError={() =>
            setStage((current) => {
              if (current === "primary") return mirrorSrc ? "mirror" : "retry";
              if (current === "mirror") return "retry";
              return "failed";
            })
          }
        />
      ) : showInitial ? (
        <span className="font-semibold leading-none" style={{ fontSize: "42cqw" }}>
          {pluginAvatarInitial(fallbackName ?? "")}
        </span>
      ) : fallbackIcon ? (
        fallbackIcon
      ) : (
        <Blocks className={cn("size-4", iconClassName)} />
      )}
    </span>
  );
}
