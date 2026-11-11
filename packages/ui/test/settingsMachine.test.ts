// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import { buildSettingsScopeGroups } from "@/settings-scope/index.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

afterEach(cleanup);

describe("设置设备标注", () => {
  const remote: WorkspaceTabState = {
    id: "remote",
    kind: "workspace",
    label: "project",
    workspacePath: "/project",
    workspaceIdentity: "remote:server:source-a:/project",
    remoteSessionId: "session",
    remoteTarget: { kind: "docker", container: "dev-container" },
  };
  const groups = buildSettingsScopeGroups({
    targets: [remote],
    devices: [{ sourceServerId: "source-a", name: "构建机", online: true }],
    remoteUserAvailable: true,
  });
  function wrap(child: React.ReactNode) {
    return createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(TooltipProvider, {}, child),
    );
  }

  it("设备分组菜单写出当前设备名，远端设备使用服务器图标", () => {
    render(
      wrap(
        createElement(PluginScopeMenu, {
          groups,
          selectedScopeKey: "source-user:source-a",
          selectedDevice: {
            kind: "remote",
            id: "source-a",
            sourceServerId: "source-a",
            name: "构建机",
          },
          onScopeKeyChange: vi.fn(),
        }),
      ),
    );
    const trigger = screen.getByRole("button");
    expect(trigger.textContent).toContain("构建机");
    expect(trigger.textContent).toContain("用户");
    expect(trigger.querySelector(".lucide-server")).toBeTruthy();
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    expect(screen.getAllByText("构建机").length).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("menuitemradio").some((item) => item.textContent?.includes("用户")),
    ).toBe(true);
    expect(screen.getByText("项目")).toBeTruthy();
  });
});
