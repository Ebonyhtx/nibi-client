import {
  collectVisibleNibiBackgroundTaskControlItems,
  getNibiBackgroundTaskControlItemElapsedMs,
  isActiveNibiBackgroundTaskControlItem,
  parseNibiBackgroundTaskControlItems,
  type NibiBackgroundTaskControlItem,
  type NibiBackgroundTaskControlStatus,
} from "./background-task-controls.js";

export type NibiBackgroundBashJobStatus = NibiBackgroundTaskControlStatus;
export type NibiBackgroundBashJob = NibiBackgroundTaskControlItem & {
  taskKind: "bash";
};

export function parseNibiBackgroundBashJobs(value: unknown): NibiBackgroundBashJob[] {
  return parseNibiBackgroundTaskControlItems(value).filter(isBackgroundBashJob);
}

export function isActiveNibiBackgroundBashJob(job: NibiBackgroundBashJob): boolean {
  return isActiveNibiBackgroundTaskControlItem(job);
}

export function getNibiBackgroundBashJobElapsedMs(
  job: NibiBackgroundBashJob,
  now = Date.now(),
): number {
  return getNibiBackgroundTaskControlItemElapsedMs(job, now);
}

export function collectVisibleNibiBackgroundBashJobs(
  jobs: readonly NibiBackgroundBashJob[],
  now = Date.now(),
  thresholdMs = 30_000,
): Array<NibiBackgroundBashJob & { elapsedMs: number }> {
  return collectVisibleNibiBackgroundTaskControlItems(jobs, now, thresholdMs) as Array<
    NibiBackgroundBashJob & { elapsedMs: number }
  >;
}

function isBackgroundBashJob(job: NibiBackgroundTaskControlItem): job is NibiBackgroundBashJob {
  return job.taskKind === "bash";
}
