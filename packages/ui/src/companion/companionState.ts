import type { ZCodeTaskRuntimeStatus } from "@nibi/shared";
import calmLoopUrl from "@/assets/nibi/companion/calm-loop.webm";
import workingLoopUrl from "@/assets/nibi/companion/working-loop.webm";
import calmToWorkingUrl from "@/assets/nibi/companion/calm-to-working.webm";
import workingToCalmUrl from "@/assets/nibi/companion/working-to-calm.webm";
import calmLoopPosterUrl from "@/assets/nibi/companion/calm-loop-poster.png";
import workingLoopPosterUrl from "@/assets/nibi/companion/working-loop-poster.png";
import calmToWorkingPosterUrl from "@/assets/nibi/companion/calm-to-working-poster.png";
import workingToCalmPosterUrl from "@/assets/nibi/companion/working-to-calm-poster.png";
import poseHeroUrl from "@/assets/nibi/companion/pose-hero.png";
import poseIdleUrl from "@/assets/nibi/companion/pose-idle.png";
import posePausedUrl from "@/assets/nibi/companion/pose-paused.png";
import poseRespondUrl from "@/assets/nibi/companion/pose-respond.png";
import poseFlyUrl from "@/assets/nibi/companion/pose-fly.png";

export type CompanionSemanticState =
  | "idle"
  | "watching"
  | "input"
  | "working"
  | "tool"
  | "child"
  | "complete"
  | "paused"
  | "warning"
  | "responding";

export type CompanionPose = "hero" | "idle" | "paused" | "respond" | "fly";
export type CompanionMotionGroup = "calm" | "working" | "paused" | "static";

export const COMPANION_POSE_BY_STATE: Record<CompanionSemanticState, CompanionPose> = {
  idle: "idle",
  watching: "hero",
  input: "hero",
  working: "fly",
  tool: "fly",
  child: "fly",
  complete: "respond",
  paused: "paused",
  warning: "paused",
  responding: "respond",
};

export const COMPANION_ACTIVITY_STATES = new Set<CompanionSemanticState>([
  "working",
  "tool",
  "child",
]);

export const COMPANION_STATIONARY_STATES = new Set<CompanionSemanticState>([
  "idle",
  "input",
  "paused",
  "warning",
]);

export const COMPANION_MOTION_ASSETS = Object.freeze({
  calmLoop: calmLoopUrl,
  workingLoop: workingLoopUrl,
  calmToWorking: calmToWorkingUrl,
  workingToCalm: workingToCalmUrl,
});

export const COMPANION_MOTION_POSTERS = Object.freeze({
  "calm-loop": calmLoopPosterUrl,
  "working-loop": workingLoopPosterUrl,
  "enter-transition": calmToWorkingPosterUrl,
  "exit-transition": workingToCalmPosterUrl,
});

export const COMPANION_POSE_ASSETS: Record<CompanionPose, string> = {
  hero: poseHeroUrl,
  idle: poseIdleUrl,
  paused: posePausedUrl,
  respond: poseRespondUrl,
  fly: poseFlyUrl,
};

export const COMPANION_MOTION_PLAYBACK_RATES = Object.freeze({
  "calm-loop": 1,
  "working-loop": 0.82,
  "enter-transition": 1,
  "exit-transition": 0.82,
});

export function companionPoseForState(state: CompanionSemanticState): CompanionPose {
  return COMPANION_POSE_BY_STATE[state] ?? "hero";
}

export function companionMotionGroupForState(state: CompanionSemanticState): CompanionMotionGroup {
  if (COMPANION_ACTIVITY_STATES.has(state)) return "working";
  if (["idle", "watching", "input", "complete", "responding"].includes(state)) return "calm";
  if (state === "paused") return "paused";
  return "static";
}

function isBusyRuntimeStatus(status: ZCodeTaskRuntimeStatus): boolean {
  return status === "creating" || status === "restoring" || status === "streaming";
}

/**
 * 只读语义映射：运行中优先于完成/失败；当前 task 的失败映射到 paused，
 * 与「出错/警告横幅」同源。
 */
export function resolveCompanionSemanticState(
  activeTaskId: string | null | undefined,
  taskRuntimeByTaskId: Record<string, { status: ZCodeTaskRuntimeStatus }>,
): CompanionSemanticState {
  const activeStatus = activeTaskId ? taskRuntimeByTaskId[activeTaskId]?.status : undefined;
  if (activeStatus === "failed") return "paused";
  if (Object.values(taskRuntimeByTaskId).some((runtime) => isBusyRuntimeStatus(runtime.status))) {
    return "working";
  }
  if (activeStatus === "completed") return "complete";
  return "idle";
}
