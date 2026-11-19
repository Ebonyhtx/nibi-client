import type {
  ComposerEditTarget,
  ComposerQueueItemEditTarget,
  ComposerUserQueryEditTarget,
} from "./contract.js";
import { composerEditTargetKey } from "./contract.js";

/** 目标身份（kind + 稳定 id）在模块内共享，避免 store / hook / 行占位各自重算。 */
export interface ComposerEditTargetIdentity {
  kind: ComposerEditTarget["kind"];
  id: string;
  key: string;
}

export function composerEditTargetIdentity(target: ComposerEditTarget): ComposerEditTargetIdentity {
  return {
    kind: target.kind,
    id: target.kind === "userQuery" ? String(target.rowId) : target.queueItemId,
    key: composerEditTargetKey(target),
  };
}

export function composerEditRowId(target: ComposerEditTarget): number | null {
  return target.kind === "userQuery" ? target.rowId : null;
}

export function composerEditQueueItemId(target: ComposerEditTarget): string | null {
  return target.kind === "queueItem" ? target.queueItemId : null;
}

export function isUserQueryEditTarget(
  target: ComposerEditTarget,
): target is ComposerUserQueryEditTarget {
  return target.kind === "userQuery";
}

export function isQueueItemEditTarget(
  target: ComposerEditTarget,
): target is ComposerQueueItemEditTarget {
  return target.kind === "queueItem";
}

export function isSameComposerEditTarget(
  left: ComposerEditTarget | null,
  right: ComposerEditTarget | null,
): boolean {
  if (left === null || right === null) return left === right;
  return composerEditTargetKey(left) === composerEditTargetKey(right);
}
