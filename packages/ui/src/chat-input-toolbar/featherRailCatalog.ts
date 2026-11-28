export interface FeatherLeaf {
  startX: number;
  startY: number;
  drift: number;
  rise: number;
  sway: number;
  fade: number;
  delay: number;
  durationOffset: number;
  rotate: number;
  rotateEnd: number;
  scale: number;
  blur: number;
  path: number;
  color: string;
}

// 四组羽色绑定到主题 CSS 变量，使思考强度「羽迹气流」随四套主题协同变色。
const FEATHER_PALETTE = [
  "var(--nibi-feather-1)",
  "var(--nibi-feather-2)",
  "var(--nibi-feather-3)",
  "var(--nibi-feather-4)",
  "var(--nibi-feather-1)",
  "var(--nibi-feather-2)",
  "var(--nibi-feather-3)",
  "var(--nibi-feather-4)",
  "var(--nibi-feather-1)",
  "var(--nibi-feather-2)",
  "var(--nibi-feather-3)",
  "var(--nibi-feather-4)",
  "var(--nibi-feather-1)",
  "var(--nibi-feather-2)",
  "var(--nibi-feather-3)",
  "var(--nibi-feather-4)",
  "var(--nibi-feather-1)",
  "var(--nibi-feather-2)",
  "var(--nibi-feather-3)",
  "var(--nibi-feather-4)",
];

export const FEATHER_LEAVES: readonly FeatherLeaf[] = Array.from(
  { length: 20 },
  (_, index) => ({
    startX: -13 + index * 4.55 + ((index * 17) % 7) * 0.7,
    startY: -9 + ((index * 31) % 20),
    drift: 112 + ((index * 43) % 148),
    rise: -12 + ((index * 37) % 25),
    sway: -24 + ((index * 19) % 52),
    fade: -28 + ((index * 23) % 58),
    delay: (index % 9) * -270,
    durationOffset: (index % 6) * 0.16,
    rotate: -58 + ((index * 31) % 116),
    rotateEnd: -76 + ((index * 47) % 152),
    scale: 0.62 + ((index * 11) % 7) * 0.08,
    blur: (index % 5) * 0.18,
    path: index % 5,
    color: FEATHER_PALETTE[index]!,
  }),
);

/** 原型的风速曲线：档位越高，风越快、越强，激活的羽毛越多。 */
export function getFeatherRailProps(value: number) {
  const normalized = Math.min(100, Math.max(0, value));
  const windDuration = Math.max(0.86, 3.85 - normalized * 0.029);
  return {
    windDuration,
    birdCycle: Math.max(0.38, windDuration * 0.17),
    birdGlideCycle: Math.max(0.8, windDuration * 1.65),
    windIntensity: 0.22 + (normalized / 100) * 2.28,
    activeFeatherCount: Math.round((normalized / 100) * FEATHER_LEAVES.length),
  };
}
