import { cn } from "@/components/lib/utils.js";
import nibiPerchedUrl from "@/assets/nibi/nibi-perched.png";

export type NibiEmptyStateArtVariant = "automation" | "archive" | "feedback";

const NAVY = "#1c2f4e";
const CREAM = "#fffdf9";
const ORANGE = "#e08a3e";
const SAGE = "#4c6b57";

function AutomationClock() {
  return (
    <>
      {/* 闹钟：奶油色表盘 + 海军蓝外圈/铃铛 + 橙色指针，和品牌三色一致。 */}
      <circle cx="24" cy="43" r="7" fill={CREAM} stroke={NAVY} strokeWidth="2.5" />
      <circle cx="72" cy="43" r="7" fill={CREAM} stroke={NAVY} strokeWidth="2.5" />
      <path d="M36 90v4M60 90v4" stroke={NAVY} strokeWidth="3" strokeLinecap="round" />
      <circle cx="48" cy="64" r="27" fill={CREAM} stroke={NAVY} strokeWidth="3" />
      <circle cx="48" cy="64" r="21" stroke="#e6d8c3" strokeWidth="1" />
      <path d="M48 64V48" stroke={ORANGE} strokeWidth="3.2" strokeLinecap="round" />
      <path d="m48 64 11 7" stroke={NAVY} strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="48" cy="64" r="3" fill={ORANGE} />
    </>
  );
}

function ArchiveBox() {
  return (
    <>
      {/* 归档箱：箱体、箱盖、橙色投递口和一张标签。 */}
      <rect x="28" y="52" width="40" height="34" rx="4" fill={CREAM} stroke={NAVY} strokeWidth="3" />
      <rect x="24" y="42" width="48" height="12" rx="3" fill={CREAM} stroke={NAVY} strokeWidth="3" />
      <rect x="40" y="60" width="16" height="4" rx="2" fill={ORANGE} />
      <rect x="36" y="70" width="24" height="9" rx="2" stroke={NAVY} strokeWidth="1.5" />
      <path d="M42 74.5h12" stroke={SAGE} strokeWidth="1.5" strokeLinecap="round" />
    </>
  );
}

function FeedbackEnvelope() {
  return (
    <>
      {/* 信封：奶油色信体、海军蓝折线、橙色火漆印。 */}
      <rect x="22" y="44" width="52" height="38" rx="4" fill={CREAM} stroke={NAVY} strokeWidth="3" />
      <path
        d="m25 48 23 17 23-17"
        stroke={NAVY}
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="48" cy="66" r="5" fill={ORANGE} />
      <path
        d="M30 77h36"
        stroke={SAGE}
        strokeWidth="1.5"
        strokeLinecap="round"
        opacity=".5"
      />
    </>
  );
}

/**
 * 空状态品牌插画：现成栖息鸟 + 物件 SVG。
 * 鸟的落脚点统一在 96 网格的 y≈43，物件顶边对齐，保证三种空态同一构图。
 */
export function NibiEmptyStateArt({
  variant,
  className,
}: {
  variant: NibiEmptyStateArtVariant;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      data-nibi-empty-state-art={variant}
      className={cn("relative size-28 shrink-0", className)}
    >
      <svg viewBox="0 0 96 96" fill="none" className="absolute inset-0 size-full">
        {variant === "automation" ? (
          <AutomationClock />
        ) : variant === "archive" ? (
          <ArchiveBox />
        ) : (
          <FeedbackEnvelope />
        )}
      </svg>
      <img
        src={nibiPerchedUrl}
        alt=""
        draggable={false}
        className="absolute left-1/2 top-0 w-[48%] -translate-x-1/2 select-none"
      />
    </div>
  );
}
