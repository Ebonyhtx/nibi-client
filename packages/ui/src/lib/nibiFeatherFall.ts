import featherOrangeUrl from "@/assets/nibi/feather-orange.png";
import featherSageUrl from "@/assets/nibi/feather-sage.png";
import { isMotionDisabled } from "@/lib/motionPreference.js";

const MAX_ACTIVE_FEATHERS = 9;

type FeatherSpec = {
  src: string;
  width: number;
  delayMs: number;
  durationMs: number;
  offsetX: number;
  offsetY: number;
  fallPx: number;
  outwardPx: number;
  swayPx: number;
  swayCycles: number;
  phase: number;
  baseRotation: number;
  rotationSway: number;
  rotationCycles: number;
  fadeStart: number;
  blurPx: number;
};

// 一大两小三片：不同宽窄、摆幅、旋转周期和淡出起点，错峰散开而不是单根直落。
const FEATHER_SPECS: readonly FeatherSpec[] = [
  {
    src: featherOrangeUrl,
    width: 26,
    delayMs: 0,
    durationMs: 1000,
    offsetX: -2,
    offsetY: -4,
    fallPx: 120,
    outwardPx: 28,
    swayPx: 16,
    swayCycles: 1.35,
    phase: 0.4,
    baseRotation: -12,
    rotationSway: 24,
    rotationCycles: 1.6,
    fadeStart: 0.62,
    blurPx: 1.2,
  },
  {
    src: featherSageUrl,
    width: 18,
    delayMs: 70,
    durationMs: 1150,
    offsetX: 4,
    offsetY: 2,
    fallPx: 150,
    outwardPx: 52,
    swayPx: 22,
    swayCycles: 1.15,
    phase: 2.1,
    baseRotation: 8,
    rotationSway: 28,
    rotationCycles: 1.3,
    fadeStart: 0.56,
    blurPx: 1,
  },
  {
    src: featherOrangeUrl,
    width: 13,
    delayMs: 170,
    durationMs: 1300,
    offsetX: 9,
    offsetY: 7,
    fallPx: 130,
    outwardPx: 38,
    swayPx: 14,
    swayCycles: 1.7,
    phase: 4,
    baseRotation: 18,
    rotationSway: 32,
    rotationCycles: 2.2,
    fadeStart: 0.64,
    blurPx: 0.9,
  },
];

type Flight = {
  element: HTMLImageElement;
  spec: FeatherSpec;
  startAt: number;
};

const flights: Flight[] = [];
let activeFeathers = 0;
let rafId: number | null = null;

function smoothstep(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped * clamped * (3 - 2 * clamped);
}

function renderFrame(flight: Flight, progress: number): void {
  const { spec, element } = flight;
  const fall = spec.fallPx * Math.pow(progress, 1.25);
  const sway =
    Math.sin(spec.phase + progress * Math.PI * 2 * spec.swayCycles) *
    spec.swayPx *
    (0.25 + 0.75 * progress);
  const x = spec.outwardPx * progress + sway;
  const rotation =
    spec.baseRotation +
    progress * 20 +
    Math.sin(spec.phase * 1.7 + progress * Math.PI * 2 * spec.rotationCycles) * spec.rotationSway;
  const scale = 1 - 0.16 * progress;
  const fade =
    progress <= spec.fadeStart
      ? 1
      : 1 - smoothstep((progress - spec.fadeStart) / (1 - spec.fadeStart));
  const blur = progress <= 0.55 ? 0 : ((progress - 0.55) / 0.45) * spec.blurPx;

  element.style.transform = `translate3d(${x}px, ${fall}px, 0) rotate(${rotation}deg) scale(${scale})`;
  element.style.opacity = `${fade}`;
  element.style.filter = `drop-shadow(0 3px 5px rgba(28, 47, 78, 0.18)) blur(${blur}px)`;
}

function tick(now: number): void {
  let active = false;
  for (const flight of flights) {
    if (!flight.element.isConnected) continue;
    if (now < flight.startAt) {
      active = true;
      continue;
    }
    const progress = Math.min((now - flight.startAt) / flight.spec.durationMs, 1);
    if (progress >= 1) {
      flight.element.remove();
      activeFeathers = Math.max(0, activeFeathers - 1);
      continue;
    }
    renderFrame(flight, progress);
    active = true;
  }
  for (let index = flights.length - 1; index >= 0; index -= 1) {
    if (!flights[index]!.element.isConnected) flights.splice(index, 1);
  }
  if (active) {
    rafId = requestAnimationFrame(tick);
    return;
  }
  rafId = null;
}

function scheduleLoop(): void {
  if (rafId !== null) return;
  rafId = requestAnimationFrame(tick);
}

export type NibiFeatherFallOrigin = { x: number; y: number };

function escapeSelectorValue(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}

/** 在视口坐标处散开一组羽毛；不写布局、不拦截指针，动效关闭时直接跳过。 */
export function playNibiFeatherFall(origin: NibiFeatherFallOrigin): void {
  if (typeof document === "undefined" || isMotionDisabled()) return;
  if (activeFeathers + FEATHER_SPECS.length > MAX_ACTIVE_FEATHERS) return;
  if (
    origin.x < -40 ||
    origin.x > window.innerWidth + 40 ||
    origin.y < -40 ||
    origin.y > window.innerHeight + 40
  ) {
    return;
  }

  const now = performance.now();
  for (const spec of FEATHER_SPECS) {
    const height = (spec.width * 44) / 53;
    const element = document.createElement("img");
    element.src = spec.src;
    element.alt = "";
    element.setAttribute("aria-hidden", "true");
    element.setAttribute("data-nibi-feather-fall", "");
    Object.assign(element.style, {
      position: "fixed",
      left: `${origin.x + spec.offsetX - spec.width / 2}px`,
      top: `${origin.y + spec.offsetY - height / 2}px`,
      width: `${spec.width}px`,
      height: "auto",
      pointerEvents: "none",
      userSelect: "none",
      zIndex: "2147483000",
      opacity: "0",
      filter: "drop-shadow(0 3px 5px rgba(28, 47, 78, 0.18))",
      willChange: "transform, opacity, filter",
    });
    document.body.append(element);
    flights.push({ element, spec, startAt: now + spec.delayMs });
    activeFeathers += 1;
  }
  scheduleLoop();
}

/** 以元素右侧中点为起点；行、按钮都适用。 */
export function playNibiFeatherFallFromRect(rect: DOMRect | null | undefined): void {
  if (!rect) return;
  playNibiFeatherFall({
    x: rect.right - 8,
    y: rect.top + Math.min(rect.height / 2, 24) - 14,
  });
}

/** 侧栏任务行；经典列表和分组列表共用 task-item-<id> 测试标识。 */
export function findTaskRowRect(taskId: string): DOMRect | null {
  if (typeof document === "undefined") return null;
  const row = document.querySelector<HTMLElement>(
    `[data-testid="task-item-${escapeSelectorValue(taskId)}"]`,
  );
  return row?.getBoundingClientRect() ?? null;
}

/** 归档管理里展开后的任务行。 */
export function findArchiveTaskRowRect(taskId: string): DOMRect | null {
  if (typeof document === "undefined") return null;
  const row = document.querySelector<HTMLElement>(
    `[data-testid="archive-task"][data-task-id="${escapeSelectorValue(taskId)}"]`,
  );
  return row?.getBoundingClientRect() ?? null;
}
