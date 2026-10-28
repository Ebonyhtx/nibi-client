import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { cn } from "@/components/lib/utils.js";
import { FEATHER_LEAVES, getFeatherRailProps } from "@/chat-input-toolbar/featherRailCatalog.js";

interface ThinkingFeatherRailProps {
  value: number;
  stopCount: number;
  currentIndex: number;
  filled: boolean;
  disabled: boolean;
  nearIndex: number | null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 思考强度轨道的装饰层：填充/高光/20 羽/风缕/轨内档位圆点。
 *
 * 原生 range 仍由父组件渲染；这里只负责视觉，不承载状态语义。
 * 羽毛按各自在轨上的位置错峰激活：填充从左扫到右时，那一段的羽毛才起飞。
 */
export function ThinkingFeatherRail({
  value,
  stopCount,
  currentIndex,
  filled,
  disabled,
  nearIndex,
}: ThinkingFeatherRailProps) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const appliedFeatherCountRef = useRef(0);
  const lastValueRef = useRef(0);
  const featherTimersRef = useRef<number[]>([]);
  const [activeLeaves, setActiveLeaves] = useState<boolean[]>(() =>
    Array<boolean>(FEATHER_LEAVES.length).fill(false),
  );
  const [driftScale, setDriftScale] = useState(1);
  const rail = getFeatherRailProps(value);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return undefined;
    const measure = () => {
      const width = track.getBoundingClientRect().width || 320;
      setDriftScale(Math.min(1, width / 490));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const clearTimers = () => {
      for (const timer of featherTimersRef.current) window.clearTimeout(timer);
      featherTimersRef.current = [];
    };
    const target = rail.activeFeatherCount;
    const applied = appliedFeatherCountRef.current;

    if (target < applied) {
      clearTimers();
      setActiveLeaves((current) => current.map((_, index) => index < target));
      appliedFeatherCountRef.current = target;
    } else if (target > applied) {
      const sweepStart = lastValueRef.current / 100;
      const sweepEnd = value / 100;
      for (let index = applied; index < target; index += 1) {
        const leaf = FEATHER_LEAVES[index];
        if (!leaf) continue;
        const fraction = FEATHER_LEAVES[index]!.startX / 100;
        const delay =
          (sweepEnd > sweepStart
            ? clamp01((fraction - sweepStart) / (sweepEnd - sweepStart))
            : 1) *
            420 +
          Math.random() * 120;
        featherTimersRef.current.push(
          window.setTimeout(() => {
            setActiveLeaves((current) => {
              if (current[index]) return current;
              const next = current.slice();
              next[index] = true;
              return next;
            });
          }, delay),
        );
      }
      appliedFeatherCountRef.current = target;
    }

    lastValueRef.current = value;
    return clearTimers;
  }, [rail.activeFeatherCount, value]);

  useEffect(
    () => () => {
      for (const timer of featherTimersRef.current) window.clearTimeout(timer);
      featherTimersRef.current = [];
    },
    [],
  );

  return (
    <div
      ref={trackRef}
      aria-hidden="true"
      data-testid="composer-thought-track"
      data-progress={value}
      className={cn("composer-thinking-track", value >= 100 && "is-peak")}
      style={
        {
          "--progress": `${value}%`,
          "--wind-duration": `${rail.windDuration}s`,
          "--wind-intensity": rail.windIntensity,
        } as CSSProperties
      }
    >
      <div
        data-max={value >= 100}
        className="composer-thinking-fill"
        style={{ width: `${value}%` }}
      />
      <div className="composer-thinking-sheen" />
      <div className="composer-thinking-feathers">
        <i className="composer-thinking-wisp composer-thinking-wisp--a" />
        <i className="composer-thinking-wisp composer-thinking-wisp--b" />
        <i className="composer-thinking-wisp composer-thinking-wisp--c" />
        {FEATHER_LEAVES.map((leaf, index) => (
          <b
            key={index}
            className={cn(
              "composer-thinking-leaf",
              `path-${leaf.path}`,
              activeLeaves[index] && "is-active",
            )}
            style={
              {
                "--leaf-x": `${leaf.startX}%`,
                "--leaf-y": `${leaf.startY}px`,
                "--leaf-drift": `${Math.round(leaf.drift * driftScale)}px`,
                "--leaf-rise": `${leaf.rise}px`,
                "--leaf-sway": `${leaf.sway}px`,
                "--leaf-fade": `${leaf.fade}px`,
                "--leaf-delay": `${leaf.delay}ms`,
                "--leaf-duration": `${rail.windDuration + leaf.durationOffset}s`,
                "--leaf-rotate": `${leaf.rotate}deg`,
                "--leaf-rotate-end": `${leaf.rotateEnd}deg`,
                "--leaf-scale": leaf.scale,
                "--leaf-blur": `${leaf.blur}px`,
                "--leaf-color": leaf.color,
              } as CSSProperties
            }
          />
        ))}
      </div>
      <div className="composer-thinking-stops">
        {Array.from({ length: stopCount }, (_, index) => (
          <i
            key={index}
            data-composer-thought-stop
            data-filled={filled && index <= currentIndex}
            data-current={index === currentIndex}
            data-near={!disabled && nearIndex === index}
            className="composer-thinking-stop"
          />
        ))}
      </div>
    </div>
  );
}
