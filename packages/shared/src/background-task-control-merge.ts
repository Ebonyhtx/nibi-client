import type { NibiBackgroundTaskControlItem } from "./background-task-controls.js";

export function mergeNibiBackgroundTaskControlItems(
  current: readonly NibiBackgroundTaskControlItem[],
  updates: readonly NibiBackgroundTaskControlItem[],
): NibiBackgroundTaskControlItem[] {
  const jobsById = new Map(current.map((job) => [job.jobId, job] as const));
  for (const job of updates) {
    jobsById.set(job.jobId, job);
  }
  return Array.from(jobsById.values());
}
