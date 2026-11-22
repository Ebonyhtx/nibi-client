// @vitest-environment jsdom
import { createElement } from "react";
import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PluginExtensionUiBridge,
  PluginUiWorkspaceProvider,
} from "@/plugin-ui/adapters/PluginUiProviders.js";

// vi.mock 工厂会提升到模块顶层，事件容器必须在 hoisted 阶段建好，避免 TDZ。
const harness = vi.hoisted(() => {
  const createEvent = <T,>() => {
    let listener: ((event: T) => void) | undefined;
    const dispose = vi.fn();
    return {
      event: (next: (event: T) => void) => {
        listener = next;
        return { dispose };
      },
      send: (event: T) => listener?.(event),
      dispose,
    };
  };
  return {
    notification: createEvent<{
      body?: string;
      pluginId: string;
      title: string;
      workspacePath: string;
    }>(),
    openView: createEvent<{
      pluginId: string;
      surfaceId: string;
      workspacePath: string;
    }>(),
    listSurfaces: vi.fn(),
    toast: vi.fn(),
    services: {} as Record<string, unknown>,
    platform: {} as Record<string, unknown>,
  };
});

vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => harness.services,
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => harness.platform,
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useNibiIntl: () => ({
    locale: "en",
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: harness.toast }));

import { toast } from "@/components/ui/toast.js";

harness.services.pluginManagementService = {
  onDynamicPluginUiOpenView: () => harness.openView.event,
  onDynamicPluginNotification: () => harness.notification.event,
};
harness.services.pluginUiBridgeService = { listSurfaces: harness.listSurfaces };
harness.listSurfaces.mockResolvedValue([
  {
    pluginId: "demo@inline",
    pluginName: "demo",
    id: "panel",
    title: "Panel",
    server: "plugin:demo:panel",
    resourceUri: "ui://demo/panel",
    availability: "session",
  },
]);
harness.platform.pluginSandbox = {};

afterEach(() => {
  vi.clearAllMocks();
});

function renderBridge(activeTaskId: string | null, workspacePath = "/repo") {
  const open = vi.fn();
  render(
    createElement(
      PluginUiWorkspaceProvider,
      { onOpenSidePane: open },
      createElement(PluginExtensionUiBridge, {
        activeTaskId,
        workspacePath,
        workspaceIdentity: "ws-1",
      }),
    ),
  );
  return open;
}

describe("PluginExtensionUiBridge", () => {
  it("opens the plugin surface through the existing side tab path", async () => {
    const open = renderBridge("session-1");
    harness.openView.send({
      pluginId: "demo@inline",
      surfaceId: "panel",
      workspacePath: "/repo",
    });
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        expect.objectContaining({
          parentSessionId: "session-1",
          pluginId: "demo@inline",
          surfaceId: "panel",
          serverName: "plugin:demo:panel",
          workspacePath: "/repo",
          workspaceIdentity: "ws-1",
          title: "Panel",
        }),
      ),
    );
  });

  it("ignores events for another workspace", async () => {
    const open = renderBridge("session-1");
    harness.openView.send({
      pluginId: "demo@inline",
      surfaceId: "panel",
      workspacePath: "/other",
    });
    await Promise.resolve();
    expect(open).not.toHaveBeenCalled();
    expect(harness.listSurfaces).not.toHaveBeenCalled();
  });

  it("does not fabricate a side tab without an active session", async () => {
    const open = renderBridge(null);
    harness.openView.send({
      pluginId: "demo@inline",
      surfaceId: "panel",
      workspacePath: "/repo",
    });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("settings.plugins.store.ui.unavailable"));
    expect(open).not.toHaveBeenCalled();
  });

  it("surfaces extension notifications as toasts", async () => {
    renderBridge("session-1");
    harness.notification.send({
      pluginId: "demo@inline",
      title: "Ready",
      body: "Index rebuilt",
      workspacePath: "/repo",
    });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Ready: Index rebuilt"));
  });
});
