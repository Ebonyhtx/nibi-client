import { flushSync } from "react-dom";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  selectWorkspaceZCodeState,
  useZCodeSessionStore,
} from "@/store/zcodeSessionStore.js";
import { useMotionDisabled } from "@/lib/motionPreference.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { getWindowControllerTaskListRegistry } from "@/v4/windowControllerTaskListRegistry.js";
import {
  COMPANION_MOTION_ASSETS,
  COMPANION_MOTION_PLAYBACK_RATES,
  COMPANION_MOTION_POSTERS,
  COMPANION_POSE_ASSETS,
  companionMotionGroupForState,
  companionPoseForState,
  resolveCompanionSemanticState,
  type CompanionMotionGroup,
  type CompanionPose,
  type CompanionSemanticState,
} from "@/companion/companionState.js";
import {
  createMotionPlayback,
  type CompanionMotionKind,
  type CompanionPlayback,
} from "@/companion/motionPlayback.js";
import {
  useCompanionPreferences,
  type CompanionMode,
} from "@/companion/companionPreferences.js";
import featherPurpleUrl from "@/assets/nibi/feather-purple.png";
import featherOrangeUrl from "@/assets/nibi/feather-orange.png";
import featherSageUrl from "@/assets/nibi/feather-sage.png";
import "@/companion/companion.css";

const MOTION_SOURCE_BY_KIND: Record<string, string> = {
  "calm-loop": COMPANION_MOTION_ASSETS.calmLoop,
  "working-loop": COMPANION_MOTION_ASSETS.workingLoop,
  "enter-transition": COMPANION_MOTION_ASSETS.calmToWorking,
  "exit-transition": COMPANION_MOTION_ASSETS.workingToCalm,
};

const LOOPING_MOTION_KINDS = new Set(["calm-loop", "working-loop"]);
const MOTION_LAYER_CLEANUP_MS = 48;
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

function useDocumentHidden(): boolean {
  const [hidden, setHidden] = useState(() =>
    typeof document === "undefined" ? false : document.hidden,
  );
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const onChange = () => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return hidden;
}

function CompanionMotionLayer({
  playback,
  controller,
}: {
  playback: CompanionPlayback;
  controller: ReturnType<typeof createMotionPlayback>;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const motionSource = MOTION_SOURCE_BY_KIND[playback.kind];
  const motionPoster = COMPANION_MOTION_POSTERS[
    playback.kind as keyof typeof COMPANION_MOTION_POSTERS
  ];
  const loopingMotion = LOOPING_MOTION_KINDS.has(playback.kind);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    return controller.mount(playback, video);
  }, [playback.key, playback.kind, controller]);

  if (!motionSource || !motionPoster) return null;

  return (
    <span
      className={`companion-video-layer companion-video-layer--${playback.kind} has-poster ${
        playback.ready ? "is-ready has-painted-frame" : ""
      } ${playback.held ? "is-held" : ""} ${
        playback.retiring ? "is-retiring" : "is-current"
      }`}
      aria-hidden="true"
    >
      <img className="companion-motion-poster" src={motionPoster} alt="" />
      <video
        ref={videoRef}
        src={motionSource}
        poster={motionPoster}
        loop={loopingMotion}
        muted
        playsInline
        preload="auto"
      />
    </span>
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
  const documentHidden = useDocumentHidden();
  const { activeTaskId, taskRuntimeByTaskId } = useZCodeSessionStore(
    useShallow((state) => {
      const workspaceState = selectWorkspaceZCodeState(
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
      windowControllerService
        ? getWindowControllerTaskListRegistry(windowControllerService)
        : null,
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
    const row = taskListRegistry.readActivities().find(
      ({ address }) =>
        address.taskId === activeTaskId &&
        (address.workspaceIdentity?.trim() || address.workspacePath) === workspaceKey,
    );
    return row?.activity ?? null;
  }, [taskListRegistry, activeTaskId, workspaceIdentity, workspacePath, activityRevision]);
  const semanticState = useMemo<CompanionSemanticState>(() => {
    if (activeActivity) {
      const pending = activeActivity.pendingInteractions;
      const pendingCount =
        (pending?.permissionCount ?? 0) + (pending?.userInputCount ?? 0);
      if (pendingCount > 0) return "paused";
      if (
        activeActivity.phase === "prewarming" ||
        activeActivity.phase === "running" ||
        activeActivity.hasBackgroundWork
      ) {
        return "working";
      }
      if (activeActivity.phase === "completedSuccess") return "complete";
      if (
        activeActivity.phase === "error" ||
        activeActivity.phase === "completedInterrupted"
      ) {
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
  const [renderPose, setRenderPose] = useState<CompanionPose>("idle");
  const [motionLayers, setMotionLayers] = useState<CompanionPlayback[]>([]);
  const motionPlaybackRef = useRef<CompanionPlayback>({ kind: "static", key: 0 });
  const motionSequenceRef = useRef(0);
  const motionRetirementTimerRef = useRef<number | null>(null);
  const motionCallbacksRef = useRef<{
    presented: (playback: CompanionPlayback) => void;
    ended: (playback: CompanionPlayback) => void;
    failed: (playback: CompanionPlayback) => void;
    held: (playback: CompanionPlayback) => void;
  }>({
    presented: () => {},
    ended: () => {},
    failed: () => {},
    held: () => {},
  });
  const motionControllerRef = useRef<ReturnType<typeof createMotionPlayback> | null>(null);
  if (!motionControllerRef.current) {
    motionControllerRef.current = createMotionPlayback({
      rates: COMPANION_MOTION_PLAYBACK_RATES,
      onPresented: (playback) => motionCallbacksRef.current.presented(playback),
      onEnded: (playback) => motionCallbacksRef.current.ended(playback),
      onFailed: (playback) => motionCallbacksRef.current.failed(playback),
      onHeld: (playback) => motionCallbacksRef.current.held(playback),
    });
  }
  const desiredMotionGroupRef = useRef<CompanionMotionGroup>("calm");
  const previousResolvedStateRef = useRef<CompanionSemanticState>("idle");

  const resolvedState: CompanionSemanticState =
    preferences.mode === "auto"
      ? semanticState
      : (MODE_STATE[preferences.mode] ?? "idle");
  const targetPose = companionPoseForState(resolvedState);
  const motionDisabled =
    documentHidden ||
    preferences.animation === "off" ||
    (preferences.animation === "independent"
      ? systemReducedMotion
      : motionDisabledByPreference);
  const feathers = preferences.feathers;
  const followPointer = preferences.follow;

  useEffect(() => {
    (["hero", "idle", "paused", "respond", "fly"] as CompanionPose[]).forEach((pose) => {
      if (companionPoseCacheRef.current.has(pose)) return;
      const image = new Image();
      image.decoding = "async";
      image.src = COMPANION_POSE_ASSETS[pose];
      companionPoseCacheRef.current.set(pose, image);
      image.decode?.().catch(() => {});
    });
  }, []);

  useEffect(() => {
    if (motionDisabled) return undefined;
    const videos = Object.values(COMPANION_MOTION_ASSETS).map((source) => {
      const video = document.createElement("video");
      video.muted = true;
      video.preload = "auto";
      video.src = source;
      video.load();
      return video;
    });
    return () =>
      videos.forEach((video) => {
        video.pause();
        video.removeAttribute("src");
        video.load();
      });
  }, [motionDisabled]);

  useEffect(() => {
    if (motionDisabled) return;
    Object.values(COMPANION_MOTION_POSTERS).forEach((source) => {
      const image = new Image();
      image.decoding = "async";
      image.src = source;
      image.decode?.().catch(() => {});
    });
  }, [motionDisabled]);

  const startMotionPlayback = (kind: CompanionMotionKind, fallbackPose: CompanionPose) => {
    setRenderPose(fallbackPose);
    if (motionPlaybackRef.current.kind === kind) return;
    if (motionRetirementTimerRef.current) {
      window.clearTimeout(motionRetirementTimerRef.current);
    }

    const next: CompanionPlayback = {
      kind,
      key: motionSequenceRef.current + 1,
      ready: false,
      retiring: false,
    };
    motionSequenceRef.current = next.key;
    motionPlaybackRef.current = next;
    motionControllerRef.current?.request(next);

    setMotionLayers((current) => {
      const visibleLayer =
        [...current].reverse().find((layer) => layer.ready && !layer.retiring) ??
        [...current].reverse().find((layer) => layer.ready);
      if (kind === "static") return visibleLayer ? [{ ...visibleLayer, retiring: true }] : [];
      return visibleLayer ? [{ ...visibleLayer, retiring: false }, next] : [next];
    });

    if (kind === "static") {
      motionRetirementTimerRef.current = window.setTimeout(
        () => setMotionLayers([]),
        MOTION_LAYER_CLEANUP_MS,
      );
    }
  };

  useEffect(() => {
    const previousState = previousResolvedStateRef.current;
    const previousGroup = companionMotionGroupForState(previousState);
    const targetGroup = companionMotionGroupForState(resolvedState);
    const currentKind = motionPlaybackRef.current.kind;
    desiredMotionGroupRef.current = targetGroup;
    previousResolvedStateRef.current = resolvedState;

    if (motionDisabled || !preferences.visible || targetGroup === "static") {
      motionControllerRef.current?.setPaused(false);
      startMotionPlayback("static", targetPose);
      return;
    }

    motionControllerRef.current?.setPaused(targetGroup === "paused");
    if (targetGroup === "paused") {
      if (currentKind === "working-loop") startMotionPlayback("exit-transition", "fly");
      else if (currentKind === "static") startMotionPlayback("calm-loop", "idle");
      return;
    }

    if (targetGroup === "working") {
      if (
        currentKind === "paused-hold" ||
        (currentKind === "calm-loop" && ["calm", "paused"].includes(previousGroup))
      ) {
        startMotionPlayback("enter-transition", "idle");
      } else if (currentKind === "exit-transition") {
        return;
      } else if (!new Set(["enter-transition", "working-loop"]).has(currentKind)) {
        startMotionPlayback("working-loop", "fly");
      }
      return;
    }

    if (currentKind === "working-loop" && previousGroup === "working") {
      startMotionPlayback("exit-transition", "fly");
    } else if (currentKind === "enter-transition") {
      return;
    } else if (currentKind !== "exit-transition" && currentKind !== "calm-loop") {
      startMotionPlayback("calm-loop", "idle");
    }
  }, [motionDisabled, preferences.visible, resolvedState, targetPose]);

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
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        const box = node.getBoundingClientRect();
        const dx = Math.max(
          -1,
          Math.min(1, (event.clientX - (box.left + box.width / 2)) / 280),
        );
        const dy = Math.max(
          -1,
          Math.min(1, (event.clientY - (box.top + box.height / 2)) / 220),
        );
        node.style.setProperty("--companion-look-x", `${(dx * 3.4).toFixed(2)}px`);
        node.style.setProperty("--companion-look-y", `${(dy * 2.1).toFixed(2)}px`);
        node.style.setProperty("--companion-tilt", `${(dx * 2.25).toFixed(2)}deg`);
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
      if (motionRetirementTimerRef.current) {
        window.clearTimeout(motionRetirementTimerRef.current);
      }
    },
    [],
  );

  const handleMotionEnded = (playback: CompanionPlayback) => {
    const current = motionPlaybackRef.current;
    if (current.key !== playback.key || current.kind !== playback.kind) return;
    if (current.kind === "enter-transition") {
      if (desiredMotionGroupRef.current === "working") startMotionPlayback("working-loop", "fly");
      else if (["calm", "paused"].includes(desiredMotionGroupRef.current)) {
        startMotionPlayback("exit-transition", "fly");
      }
    }
    if (current.kind === "exit-transition") {
      if (desiredMotionGroupRef.current === "calm") startMotionPlayback("calm-loop", "idle");
      else if (desiredMotionGroupRef.current === "working") {
        startMotionPlayback("enter-transition", "idle");
      }
    }
  };

  const handleMotionFramePainted = (playback: CompanionPlayback) => {
    if (motionPlaybackRef.current.key !== playback.key) return;
    // 视频可见性与静态兜底在同一个 commit 里切换，且在解码帧回调内完成，浏览器不会画出中间态。
    flushSync(() =>
      setMotionLayers((current) =>
        current.map((layer) =>
          layer.key === playback.key
            ? { ...layer, ready: true, retiring: false }
            : { ...layer, retiring: true },
        ),
      ),
    );
    if (motionRetirementTimerRef.current) {
      window.clearTimeout(motionRetirementTimerRef.current);
    }
    motionRetirementTimerRef.current = window.setTimeout(() => {
      setMotionLayers((current) => current.filter((layer) => layer.key === playback.key));
    }, MOTION_LAYER_CLEANUP_MS);
  };

  motionCallbacksRef.current = {
    presented: handleMotionFramePainted,
    ended: handleMotionEnded,
    failed: (playback) => {
      if (motionPlaybackRef.current.key === playback.key) {
        startMotionPlayback("static", targetPose);
      }
    },
    held: (playback) => {
      if (
        motionPlaybackRef.current.key !== playback.key ||
        desiredMotionGroupRef.current !== "paused"
      ) {
        return;
      }
      motionPlaybackRef.current = { ...motionPlaybackRef.current, kind: "paused-hold" };
      flushSync(() =>
        setMotionLayers((current) =>
          current.map((layer) =>
            layer.key === playback.key ? { ...layer, held: true } : layer,
          ),
        ),
      );
    },
  };

  const handleCompanionClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (motionDisabled) return;
    const avatar = companionRef.current?.querySelector<HTMLElement>(
      ".companion-interaction-layer",
    );
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
          { opacity: 1, filter: "saturate(1.12)", offset: 0.42 },
          { opacity: 0.9, filter: "saturate(1.03)", offset: 0.72 },
          { opacity: 1, filter: "saturate(1)" },
        ],
        { duration: 720, easing: "cubic-bezier(.2,.74,.2,1)", fill: "none" },
      );
    }
  };

  if (!preferences.visible) return null;

  const activeMotionReady =
    !motionDisabled && motionLayers.some((layer) => layer.ready && !layer.retiring);
  const motionVisible = motionLayers.length > 0 && !motionDisabled;

  return (
    <section
      className={`companion-anchor is-state-${resolvedState} is-motion-${
        motionPlaybackRef.current.kind
      } ${motionDisabled ? "is-motion-reduced" : ""}`}
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
        <span className="companion-perch-zone" aria-hidden="true" />
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
                <img src={featherPurpleUrl} alt="" />
                <img src={featherOrangeUrl} alt="" />
                <img src={featherSageUrl} alt="" />
                <img src={featherPurpleUrl} alt="" />
              </span>
            ) : null}
          </span>
          <span className="companion-avatar-stage">
            <span className="companion-interaction-layer">
              <span className={`companion-pose-motion companion-pose-motion--${resolvedState}`}>
                <span
                  className={`companion-pose-layer is-current companion-pose-layer--${renderPose} ${
                    activeMotionReady ? "is-motion-ready" : ""
                  }`}
                >
                  <img src={COMPANION_POSE_ASSETS[renderPose]} alt="" />
                </span>
                {motionVisible
                  ? motionLayers.map((playback) => (
                      <CompanionMotionLayer
                        key={playback.key}
                        playback={playback}
                        controller={motionControllerRef.current!}
                      />
                    ))
                  : null}
              </span>
            </span>
          </span>
        </span>
      </button>
    </section>
  );
}
