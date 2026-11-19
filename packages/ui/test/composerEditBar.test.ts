// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ComposerEditBar } from "@/composer-edit-mode/ComposerEditBar.js";
import type { ComposerEditTarget } from "@/composer-edit-mode/contract.js";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";

const userTarget: ComposerEditTarget = {
  kind: "userQuery",
  sessionId: "session-a",
  workspaceKey: "/workspace",
  rowId: 42,
  entityId: "message-user-42",
};
const queueTarget: ComposerEditTarget = {
  kind: "queueItem",
  sessionId: "session-a",
  workspaceKey: "/workspace",
  queueItemId: "queue-1",
};

function renderBar(props: Parameters<typeof ComposerEditBar>[0], locale = "zh-CN") {
  return createElement(
    NibiIntlProvider,
    { initialLocale: locale },
    createElement(ComposerEditBar, props),
  );
}

afterEach(cleanup);

describe("ComposerEditBar", () => {
  it("暴露 target/state 属性并提供 rewind 与取消", () => {
    const onRewind = vi.fn();
    const onCancel = vi.fn();
    render(
      renderBar({
        target: userTarget,
        state: "editing",
        canRewind: true,
        onRewind,
        onCancel,
      }),
    );

    const bar = screen.getByTestId("v4-composer-edit-bar");
    expect(bar.getAttribute("data-edit-target-kind")).toBe("userQuery");
    expect(bar.getAttribute("data-edit-target-id")).toBe("42");
    expect(bar.getAttribute("data-edit-state")).toBe("editing");
    expect(bar.getAttribute("data-invalid-reason")).toBeNull();
    expect(bar.textContent).toContain("编辑消息");

    fireEvent.click(screen.getByTestId("v4-composer-edit-rewind"));
    fireEvent.click(screen.getByTestId("v4-composer-edit-cancel"));
    expect(onRewind).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("invalid 时显示原因并禁用 rewind，队列项没有 rewind", () => {
    const { rerender } = render(
      renderBar(
        {
          target: queueTarget,
          state: "invalid",
          invalidReason: "editLockLost",
          canRewind: true,
          onRewind: vi.fn(),
          onCancel: vi.fn(),
        },
        "en-US",
      ),
    );

    const bar = screen.getByTestId("v4-composer-edit-bar");
    expect(bar.getAttribute("data-edit-target-kind")).toBe("queueItem");
    expect(bar.getAttribute("data-edit-target-id")).toBe("queue-1");
    expect(bar.getAttribute("data-edit-state")).toBe("invalid");
    expect(bar.getAttribute("data-invalid-reason")).toBe("editLockLost");
    expect(bar.textContent).toContain("The edit lock for this queued message was lost.");
    expect(screen.queryByTestId("v4-composer-edit-rewind")).toBeNull();

    rerender(
      renderBar(
        {
          target: userTarget,
          state: "invalid",
          invalidReason: "notLatest",
          canRewind: true,
          rewindDisabled: true,
          onRewind: vi.fn(),
          onCancel: vi.fn(),
        },
        "en-US",
      ),
    );
    expect((screen.getByTestId("v4-composer-edit-rewind") as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.getByTestId("v4-composer-edit-bar").textContent).toContain(
      "This message can no longer be edited",
    );
  });
});
