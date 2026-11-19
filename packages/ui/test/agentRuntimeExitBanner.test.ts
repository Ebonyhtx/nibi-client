// @vitest-environment jsdom

import { createElement } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { NibiAgentRuntimeExitedEvent } from "@nibi/services";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";
import { AgentRuntimeExitBanner } from "@/v4/AgentRuntimeExitBanner.js";

function exitEvent(
  overrides: Partial<NibiAgentRuntimeExitedEvent> = {},
): NibiAgentRuntimeExitedEvent {
  return {
    workspacePath: "/repo",
    workspaceKey: "/repo",
    runtimeIdentity: { generation: 1, identity: "runtime-1", workspaceKey: "/repo" },
    exitCode: 1,
    signal: null,
    category: "crash",
    exitedAt: 1,
    ...overrides,
  };
}

function renderBanner(
  exit: NibiAgentRuntimeExitedEvent,
  recovery: "pending" | "restarted" = "pending",
) {
  const onDismiss = vi.fn();
  render(
    createElement(
      NibiIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(AgentRuntimeExitBanner, { exit, recovery, onDismiss }),
    ),
  );
  return { onDismiss };
}

describe("AgentRuntimeExitBanner", () => {
  it("非阻断展示意外退出原因，并可忽略", () => {
    const { onDismiss } = renderBanner(exitEvent());
    expect(screen.getByTestId("v4-agent-runtime-exit-banner")).toBeTruthy();
    expect(screen.getByText(/运行时意外退出，正在尝试自动重启/)).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("v4-agent-runtime-exit-dismiss"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("自动重启后文案切换为已重启", () => {
    renderBanner(exitEvent(), "restarted");
    expect(screen.getByText(/已自动重启/)).toBeTruthy();
  });

  it("OOM 退出说明内存不足", () => {
    renderBanner(exitEvent({ category: "oom", exitCode: 0xe0000008 }));
    expect(screen.getByText(/系统内存不足/)).toBeTruthy();
  });
});