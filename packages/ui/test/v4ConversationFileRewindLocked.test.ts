// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { V4ConversationFileRewindPreviewResult } from "@nibi/shared/nibi-protocol-v4";
import { TID_V4_FILE_REWIND_CONFIRM_LOCKED } from "@nibi/shared/test-ids";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationFileRewindDialog } from "@/v4/ConversationFileRewindDialog.js";

vi.mock("@/ControlHintTooltip.js", async () => {
  const React = await import("react");
  return {
    ControlHintTooltip: ({
      title,
      children,
    }: {
      title: React.ReactNode;
      children?: React.ReactNode;
    }) => React.createElement("span", { "data-tooltip-title": String(title) }, children),
  };
});

afterEach(cleanup);

const preview: V4ConversationFileRewindPreviewResult = {
  canApply: true,
  safeFiles: [],
  unsafeFiles: [],
  ignoredFiles: [],
};

function renderDialog(applyLocked: boolean) {
  return render(
    createElement(
      NibiIntlProvider,
      { initialLocale: "en-US" },
      createElement(ConversationFileRewindDialog, {
        open: true,
        onOpenChange: vi.fn(),
        preview,
        previewLoading: false,
        applying: false,
        error: null,
        onApply: vi.fn(),
        applyLocked,
      }),
    ),
  );
}

describe("ConversationFileRewindDialog apply lock", () => {
  it("disables Undo files and exposes the shared lock tooltip", () => {
    renderDialog(true);

    const trigger = screen.getByTestId(TID_V4_FILE_REWIND_CONFIRM_LOCKED);
    expect(trigger.parentElement?.getAttribute("data-tooltip-title")).toContain(
      "The session is running or has a pending request",
    );
    const button = trigger.querySelector("button");
    expect(button?.disabled).toBe(true);
  });

  it("keeps Undo files enabled without the lock", () => {
    renderDialog(false);

    expect(screen.queryByTestId(TID_V4_FILE_REWIND_CONFIRM_LOCKED)).toBeNull();
    expect(screen.getByRole("button", { name: /Undo files/ }).hasAttribute("disabled")).toBe(
      false,
    );
  });
});
