import type { NibiSessionStateSnapshot } from "@nibi/shared";
import type {
  NibiSessionWorkspaceTarget,
  NibiTaskTarget,
} from "#src/nibi-session/nibiSession.js";

function getWorkspaceKey(target: NibiSessionWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

function getSessionScopedKey(target: NibiTaskTarget): string {
  return `${getWorkspaceKey(target)}\0${target.sessionId}`;
}

export function createNibiDeferredDraftRegistry() {
  const sessionKeys = new Set<string>();

  return {
    remember(params: NibiSessionWorkspaceTarget, snapshot: NibiSessionStateSnapshot): void {
      sessionKeys.add(
        getSessionScopedKey({
          workspacePath: snapshot.session.workspace.workspacePath,
          workspaceIdentity:
            snapshot.session.workspace.workspaceIdentity ?? params.workspaceIdentity,
          sessionId: snapshot.session.sessionId,
        }),
      );
    },

    has(target: NibiTaskTarget): boolean {
      return sessionKeys.has(getSessionScopedKey(target));
    },

    forget(target: NibiTaskTarget): void {
      sessionKeys.delete(getSessionScopedKey(target));
    },
  };
}
