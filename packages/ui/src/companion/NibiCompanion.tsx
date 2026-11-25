import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { selectWorkspaceNibiState, useNibiSessionStore } from "@/store/nibiSessionStore.js";
import { useMotionDisabled } from "@/lib/motionPreference.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { getWindowControllerTaskListRegistry } from "@/v4/windowControllerTaskListRegistry.js";
import {
  COMPANION_POSE_ASSETS,
  companionPoseForState,
  resolveCompanionSemanticState,
  type CompanionPose,
  type CompanionSemanticState,
} from "@/companion/companionState.js";
import { useCompanionPreferences, type CompanionMode } from "@/companion/companionPreferences.js";
import "@/companion/companion.css";

const ALL_POSES: readonly CompanionPose[] = ["hero", "idle", "paused", "respond", "fly"];
const subscribeToNothing = () => () => {};
const getZeroRevision = () => 0;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function useSystemReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(REDUCED_MOTION_QUERY).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => setReduced(query.matches);
    onChange();
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

const MODE_STATE: Record<Exclude<CompanionMode, "auto">, CompanionSemanticState> = {
  perch: "watching",
  working: "working",
  complete: "complete",
  paused: "paused",
};

function AtelierPerchStroke() {
  return (
    <svg
      viewBox="0 0 116 14"
      className="companion-perch-stroke"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M6 8.5C28 5.2 66 4.4 110 8.2C90 9.8 36 10.2 6 8.5Z"
        fill="currentColor"
        opacity="0.72"
      />
      <path
        d="M18 10.6C42 9.4 76 9.3 98 10.5"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinecap="round"
        fill="none"
        opacity="0.45"
      />
    </svg>
  );
}

function AtelierFeatherWisp({ variant }: { variant: "ochre" | "indigo" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={`companion-feather-wisp companion-feather-wisp--${variant}`}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M19.2 4.6C14.1 5.1 9.6 8.2 6.8 13.6C5.6 15.9 5.2 18.1 4.5 19.6C6.9 18.9 9.7 17.8 12.1 15.9C16.3 12.5 18.8 8.3 19.2 4.6Z"
        fill="currentColor"
        fillOpacity="0.62"
      />
      <path
        d="M3.8 20.2C7.4 16.5 12.5 11.4 18.2 5.6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        fill="none"
        strokeOpacity="0.78"
      />
    </svg>
  );
}

export function NibiCompanion({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath?: string;
  workspaceIdentity?: string;
}) {
  const preferences = useCompanionPreferences();
  const motionDisabledByPreference = useMotionDisabled();
  const systemReducedMotion = useSystemReducedMotion();
  const { activeTaskId, taskRuntimeByTaskId } = useNibiSessionStore(
    useShallow((state) => {
      const workspaceState = selectWorkspaceNibiState(
        state,
        workspacePath ?? "",
        workspaceIdentity,
      );
      return {
        activeTaskId: workspaceState.activeTaskId,
        taskRuntimeByTaskId: workspaceState.taskRuntimeByTaskId,
      };
    }),
  );
  const baseServices = useBaseWorkspaceServices();
  const windowControllerService = baseServices.windowControllerService;
  const taskListRegistry = useMemo(
    () =>
      windowControllerService ? getWindowControllerTaskListRegistry(windowControllerService) : null,
    [windowControllerService],
  );
  const activityRevision = useSyncExternalStore(
    taskListRegistry ? taskListRegistry.subscribe : subscribeToNothing,
    taskListRegistry ? taskListRegistry.getRevision : getZeroRevision,
    taskListRegistry ? taskListRegistry.getRevision : getZeroRevision,
  );
  // v4 的实时运行态在 sessions-index（与任务列表转圈同源），旧 taskRuntimeByTaskId
  // 不再接收后台会话 delta；这里优先读 controller 的 activity，缺失时再回退旧 map。
  const activeActivity = useMemo(() => {
    if (!taskListRegistry || !activeTaskId) return null;
    const workspaceKey = workspaceIdentity?.trim() || workspacePath?.trim();
    if (!workspaceKey) return null;
    const row = taskListRegistry
      .readActivities()
      .find(
        ({ address }) =>
          address.taskId === activeTaskId &&
          (address.workspaceIdentity?.trim() || address.workspacePath) === workspaceKey,
      );
    return row?.activity ?? null;
  }, [taskListRegistry, activeTaskId, workspaceIdentity, workspacePath, activityRevision]);
  const semanticState = useMemo<CompanionSemanticState>(() => {
    if (activeActivity) {
      const pending = activeActivity.pendingInteractions;
      const pendingCount = (pending?.permissionCount ?? 0) + (pending?.userInputCount ?? 0);
      if (pendingCount > 0) return "paused";
      if (
        activeActivity.phase === "prewarming" ||
        activeActivity.phase === "running" ||
        activeActivity.hasBackgroundWork
      ) {
        return "working";
      }
      if (activeActivity.phase === "completedSuccess") return "complete";
      if (activeActivity.phase === "error" || activeActivity.phase === "completedInterrupted") {
        return "paused";
      }
      return "idle";
    }
    return resolveCompanionSemanticState(activeTaskId, taskRuntimeByTaskId);
  }, [activeActivity, activeTaskId, taskRuntimeByTaskId]);
  const companionPoseCacheRef = useRef(new Map<CompanionPose, HTMLImageElement>());
  const companionRef = useRef<HTMLElement>(null);
  const interactionAnimationRef = useRef<Animation | null>(null);
  const interactionAtmosphereRef = useRef<Animation | null>(null);

  const resolvedState: CompanionSemanticState =
    preferences.mode === "auto" ? semanticState : (MODE_STATE[preferences.mode] ?? "idle");
  const targetPose = companionPoseForState(resolvedState);
  const motionDisabled =
    preferences.animation === "off" ||
    (preferences.animation === "independent" ? systemReducedMotion : motionDisabledByPreference);
  const feathers = preferences.feathers;
  const followPointer = preferences.follow;

  useEffect(() => {
    ALL_POSES.forEach((pose) => {
      if (companionPoseCacheRef.current.has(pose)) return;
      const image = new Image();
      image.decoding = "async";
      image.src = COMPANION_POSE_ASSETS[pose];
      companionPoseCacheRef.current.set(pose, image);
      image.decode?.().catch(() => {});
    });
  }, []);

  useEffect(() => {
    const node = companionRef.current;
    if (!node || !followPointer || motionDisabled) {
      node?.style.setProperty("--companion-look-x", "0px");
      node?.style.setProperty("--companion-look-y", "0px");
      node?.style.setProperty("--companion-tilt", "0deg");
      return undefined;
    }
    let frame = 0;
    const trackPointer = (event: PointerEvent) => {
      if (typeof document !== "undefined" && document.hidden) {
        return;
      }
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (typeof document !== "undefined" && document.hidden) {
          return;
        }
        const box = node.getBoundingClientRect();
        const dx = Math.max(-1, Math.min(1, (event.clientX - (box.left + box.width / 2)) / 280));
        const dy = Math.max(-1, Math.min(1, (event.clientY - (box.top + box.height / 2)) / 220));
        node.style.setProperty("--companion-look-x", `${(dx * 3.0).toFixed(2)}px`);
        node.style.setProperty("--companion-look-y", `${(dy * 1.8).toFixed(2)}px`);
        node.style.setProperty("--companion-tilt", `${(dx * 2.0).toFixed(2)}deg`);
      });
    };
    window.addEventListener("pointermove", trackPointer, { passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", trackPointer);
    };
  }, [followPointer, motionDisabled]);

  useEffect(
    () => () => {
      interactionAnimationRef.current?.cancel();
      interactionAtmosphereRef.current?.cancel();
    },
    [],
  );

  const handleCompanionClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (motionDisabled) return;
    const avatar = companionRef.current?.querySelector<HTMLElement>(".companion-interaction-layer");
    const atmosphere = companionRef.current?.querySelector<HTMLElement>(".companion-atmosphere");
    if (!avatar?.animate) return;
    if (interactionAnimationRef.current?.playState === "running") return;
    const bounds = avatar.getBoundingClientRect();
    const direction = event.clientX < bounds.left + bounds.width / 2 ? -1 : 1;
    interactionAnimationRef.current = avatar.animate(
      [
        {
          transform: "translate3d(0, 0, 0) rotate(0deg) scale(1)",
          easing: "cubic-bezier(.32,.02,.38,1)",
        },
        {
          transform: `translate3d(${direction * 0.7}px, 1.1px, 0) rotate(${direction * -0.42}deg) scale(.992, .984)`,
          offset: 0.15,
          easing: "cubic-bezier(.16,.82,.22,1)",
        },
        {
          transform: `translate3d(${direction * 1.45}px, -3.6px, 0) rotate(${direction * 0.82}deg) scale(1.013, 1.018)`,
          offset: 0.38,
          easing: "cubic-bezier(.2,.72,.2,1)",
        },
        {
          transform: `translate3d(${direction * 0.48}px, -1.35px, 0) rotate(${direction * -0.24}deg) scale(1.004)`,
          offset: 0.62,
          easing: "cubic-bezier(.2,.76,.24,1)",
        },
        {
          transform: `translate3d(${direction * -0.12}px, 0.28px, 0) rotate(${direction * 0.08}deg) scale(.999, 1.002)`,
          offset: 0.84,
          easing: "ease-out",
        },
        { transform: "translate3d(0, 0, 0) rotate(0deg) scale(1)" },
      ],
      { duration: 760, easing: "linear", fill: "none" },
    );
    if (atmosphere?.animate) {
      interactionAtmosphereRef.current = atmosphere.animate(
        [
          { opacity: 1, filter: "saturate(1)" },
          { opacity: 0.72, filter: "saturate(.9)", offset: 0.16 },
          { opacity: 1, filter: "saturate(1.1)", offset: 0.42 },
          { opacity: 0.9, filter: "saturate(1.02)", offset: 0.72 },
          { opacity: 1, filter: "saturate(1)" },
        ],
        { duration: 720, easing: "cubic-bezier(.2,.74,.2,1)", fill: "none" },
      );
    }
  };

  if (!preferences.visible) return null;

  return (
    <section
      className={`companion-anchor is-state-${resolvedState} is-motion-static ${
        motionDisabled ? "is-motion-reduced" : ""
      }`}
      data-companion-pose={targetPose}
      data-companion-state={resolvedState}
      ref={companionRef}
      aria-label="NIBI Companion"
    >
      <button
        type="button"
        className="companion-dock"
        aria-label="NIBI Companion"
        onClick={handleCompanionClick}
      >
        <span className="companion-activity-zone" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="companion-perch-zone" aria-hidden="true">
          <AtelierPerchStroke />
        </span>
        <span className="companion-avatar">
          <span className="companion-atmosphere" aria-hidden="true">
            <span className="companion-airflow">
              <i />
              <i />
              <i />
              <i />
            </span>
            {feathers ? (
              <span className="companion-feathers">
                <AtelierFeatherWisp variant="ochre" />
                <AtelierFeatherWisp variant="indigo" />
                <AtelierFeatherWisp variant="ochre" />
                <AtelierFeatherWisp variant="indigo" />
              </span>
            ) : null}
          </span>
          <span className="companion-avatar-stage">
            <span className="companion-interaction-layer">
              <span className={`companion-pose-motion companion-pose-motion--${resolvedState}`}>
                {ALL_POSES.map((pose) => (
                  <span
                    key={pose}
                    className={`companion-pose-layer companion-pose-layer--${pose} ${
                      pose === targetPose ? "is-current" : ""
                    }`}
                  >
                    <img src={COMPANION_POSE_ASSETS[pose]} alt="" />
                  </span>
                ))}
              </span>
            </span>
          </span>
        </span>
      </button>
    </section>
  );
}
