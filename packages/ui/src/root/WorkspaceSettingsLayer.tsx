import { lazy, Suspense, useEffect } from "react";
import { ServiceProvider } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import type { WorkspaceSettingsLayerProps } from "@/root/types.js";

const LazySettingsPage = lazy(() =>
  import("@/SettingsPage.js").then((module) => ({ default: module.SettingsPage })),
);

export function WorkspaceSettingsLayer({
  workspaceScopedServices,
  isDesktop,
  isMacDesktop,
  isWindowsDesktop,
  isWebRemoteControl,
  windowsWindowControlsRightPaddingPx,
  captionWorkspacePath,
  onBack,
  onCreateTask,
  onOpenWorkspace,
  onOpenRemoteWorkspace,
  allowOpenWorkspace,
  onLogin,
  onLogout,
  user,
}: WorkspaceSettingsLayerProps) {
  useEffect(() => {
    logger.info("[Root] settings layer mounted");
    return () => {
      logger.info("[Root] settings layer unmounted");
    };
  }, []);

  return (
    <div className="absolute inset-0 z-10">
      <Suspense fallback={null}>
        {workspaceScopedServices ? (
          <ServiceProvider services={workspaceScopedServices}>
            <LazySettingsPage
              isDesktop={isDesktop}
              isMacDesktop={isMacDesktop}
              isWindowsDesktop={isWindowsDesktop}
              isWebRemoteControl={isWebRemoteControl}
              windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
              captionWorkspacePath={captionWorkspacePath}
              onBack={onBack}
              onCreateTask={onCreateTask}
              onOpenWorkspace={onOpenWorkspace}
              onOpenRemoteWorkspace={onOpenRemoteWorkspace}
              allowOpenWorkspace={allowOpenWorkspace}
              onLogin={onLogin}
              onLogout={onLogout}
              user={user}
            />
          </ServiceProvider>
        ) : (
          <LazySettingsPage
            isDesktop={isDesktop}
            isMacDesktop={isMacDesktop}
            isWindowsDesktop={isWindowsDesktop}
            isWebRemoteControl={isWebRemoteControl}
            windowsWindowControlsRightPaddingPx={windowsWindowControlsRightPaddingPx}
            captionWorkspacePath={captionWorkspacePath}
            onBack={onBack}
            onCreateTask={onCreateTask}
            onOpenWorkspace={onOpenWorkspace}
            onOpenRemoteWorkspace={onOpenRemoteWorkspace}
            allowOpenWorkspace={allowOpenWorkspace}
            onLogin={onLogin}
            onLogout={onLogout}
            user={user}
          />
        )}
      </Suspense>
    </div>
  );
}
