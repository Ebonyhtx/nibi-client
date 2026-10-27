import { useEffect, useState, type ReactNode } from "react";
import { Blocks } from "lucide-react";
import { nibiMirrorUrlForContent } from "@nibi/shared";
import { cn } from "@/components/lib/utils.js";
import { resolvePluginIconSource } from "@/lib/pluginIconSource.js";

/**
 * Plugin 原始图标；支持官方内置图标与 HTTPS，缺失或失败时使用调用方兜底，默认回退 Blocks。
 *
 * 加载顺序：主源 → **国内镜像**（仅我们的内容主机）→ 兜底图标。
 * 这条兜底规则与清单/zip/配置的「主源失败退镜像」是同一条（见 shared/nibiContentMirror），
 * 区别只是这里发生在渲染进程的 `<img>` 上：主源被线路阻断时图标不该整片变成默认图标。
 * 镜像用自签证书，渲染 session 对镜像主机的证书信任由主进程单独放行（desktopNetworkPolicy）。
 */
export function PluginIcon({
  src,
  pluginId,
  className,
  iconClassName,
  fallbackIcon,
}: {
  src?: string;
  pluginId?: string;
  className?: string;
  iconClassName?: string;
  fallbackIcon?: ReactNode;
}) {
  const primarySrc = resolvePluginIconSource(pluginId, src);
  const mirrorSrc = primarySrc ? nibiMirrorUrlForContent(primarySrc) : null;
  const [stage, setStage] = useState<"primary" | "mirror" | "failed">("primary");

  // 换图标（切换插件/商店刷新）时重新从主源开始，不能沿用上一个地址的失败状态。
  useEffect(() => {
    setStage("primary");
  }, [primarySrc]);

  const resolvedSrc =
    stage === "primary" ? primarySrc : stage === "mirror" ? (mirrorSrc ?? undefined) : undefined;
  const showImage = Boolean(resolvedSrc);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 select-none items-center justify-center overflow-hidden rounded-xl bg-surface",
        !showImage && "text-foreground-subtle",
        className,
      )}
    >
      {showImage ? (
        <img
          src={resolvedSrc}
          alt=""
          draggable={false}
          className="size-full object-contain"
          onError={() =>
            setStage((current) => (current === "primary" && mirrorSrc ? "mirror" : "failed"))
          }
        />
      ) : fallbackIcon ? (
        fallbackIcon
      ) : (
        <Blocks className={cn("size-4", iconClassName)} />
      )}
    </span>
  );
}
