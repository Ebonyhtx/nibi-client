// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QueueState } from "@nibi/shared/nibi-protocol-v4";
import { ConversationQueuePanel } from "@/v4/ConversationQueuePanel.js";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";

vi.mock("@/ControlHintTooltip.js", async () => {
  const React = await import("react");
  return {
    ControlHintTooltip: ({ children }: { children: ReactNode }) =>
      React.createElement(React.Fragment, null, children),
  };
});

afterEach(() => {
  cleanup();
});

function lockedQueue(): QueueState {
  return {
    autoDrain: true,
    items: [
      {
        queueItemId: "q-1",
        kind: "sendText",
        text: "排队原文",
        sourceCommandId: "cmd-1",
        clientId: "cli",
        attachments: [],
        delivery: { requested: "queue", admitted: "queue" },
        order: { admissionSeq: 1, queuePosition: 0 },
        steer: { state: "notRequested" },
        dispatch: { state: "queued" },
        admittedAt: 1,
        editLock: { editorId: "editor-b", clientId: "mobile", inputOrigin: "mobile" },
      },
    ],
  };
}

describe("ConversationQueuePanel edit lock release", () => {
  it("点击释放调用 onReleaseEditLock(queueItemId)", () => {
    const onReleaseEditLock = vi.fn();
    render(
      createElement(
        NibiIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(ConversationQueuePanel, {
          queue: lockedQueue(),
          editorId: "editor-a",
          onReleaseEditLock,
        }),
      ),
    );
    fireEvent.click(screen.getByTestId("v4-queue-item-release-edit-q-1"));
    expect(onReleaseEditLock).toHaveBeenCalledWith("q-1");
  });
});
