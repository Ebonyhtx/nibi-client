import { NibiAppLogo } from "@nibi/ui/app-logo";

/** 连接前各页的页头品牌：桌面端同款 logo 图标 + “NIBI”文字，纯静态标识，不可点击。 */
export function WebRemoteControlBrand({
  className,
  subtitle,
}: {
  className?: string;
  subtitle?: string;
}) {
  return (
    <span className={["inline-flex items-center gap-2.5", className].filter(Boolean).join(" ")}>
      <NibiAppLogo className="size-6 rounded-md shadow-xs" />
      <span className="text-ui-base font-semibold tracking-tight text-foreground">NIBI</span>
      {subtitle ? (
        <span className="inline-flex items-center rounded-full border border-border bg-surface px-2.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
          {subtitle}
        </span>
      ) : null}
    </span>
  );
}
