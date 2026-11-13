import { describe, expect, it, vi } from "vitest";
import {
  nibiProtocolMethods,
  nibiProtocolNotifications,
  type NibiPluginOperationProgressNotification,
} from "@nibi/shared";

describe("nibiAgentService Plugin operation progress", () => {
  it("projects a validated Agent progress notification by operationId", async () => {
    let notificationListener:
      | ((notification: { method: string; params?: unknown }) => void)
      | null = null;
    const request = vi.fn(async (method: string) => {
      if (method !== nibiProtocolMethods.pluginsResolveSuggestedReference) {
        throw new Error(`Unexpected request method: ${method}`);
      }
      notificationListener?.({
        method: nibiProtocolNotifications.pluginOperationProgress,
        params: { operationId: "suggested-progress", state: "refreshing" },
      });
      return {
        stableId: "document-skills@nibi-official",
        status: "missing",
        marketplace: "nibi-official",
        pluginName: "document-skills",
        sourceTrust: "official",
        diagnostics: [],
      };
    });

    vi.resetModules();
    vi.doMock("../src/nibi-agent/nibiAgentProcessManager.js", () => ({
      NibiAgentProcessManager: class {
        onRuntimeLifecycle() {
          return { dispose() {} };
        }
        onRuntimeRestarted() {
          return { dispose() {} };
        }
        async getClient() {
          return {
            request,
            transportKind: "stdio",
            onNotification: (
              listener: (notification: { method: string; params?: unknown }) => void,
            ) => {
              notificationListener = listener;
              return { dispose() {} };
            },
            onRequest: () => ({ dispose() {} }),
            onClose: () => ({ dispose() {} }),
          };
        }
        disposeAll() {}
        async disposeAllAndWait() {}
      },
    }));
    const { createNibiAgentService } = await import("../src/nibi-agent/nibiAgentService.js");
    const service = createNibiAgentService();
    const received: NibiPluginOperationProgressNotification[] = [];
    const subscription = service.onDynamicPluginOperationProgress("suggested-progress")((event) =>
      received.push(event),
    );

    try {
      await service.resolveSuggestedPluginReference({
        workspacePath: "/workspace",
        stableId: "document-skills@nibi-official",
        operationId: "suggested-progress",
        clientMode: "desktop-continuous",
        deliveryKind: "desktop-continuous",
      });

      expect(received).toEqual([{ operationId: "suggested-progress", state: "refreshing" }]);

      notificationListener?.({
        method: nibiProtocolNotifications.pluginOperationProgress,
        params: {
          operationId: "suggested-progress",
          state: "refreshing",
          unexpected: true,
        },
      });
      expect(received).toHaveLength(1);
    } finally {
      subscription.dispose();
      await service.disposeAllAndWait();
    }
  });
});
