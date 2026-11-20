// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TID_V4_EDIT_IN_COMPOSER_HINT, testId } from "@nibi/shared/test-ids";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";
import { ComposerEditInComposerHint } from "@/v4/ConversationRowView.js";

afterEach(cleanup);

function renderHint(onFocus?: () => void) {
  return render(
    createElement(
      NibiIntlProvider,
      { initialLocale: "en-US" },
      createElement(ComposerEditInComposerHint, { rowId: 42, onFocus }),
    ),
  );
}

describe("ComposerEditInComposerHint", () => {
  it("shows the Editing below hint for the edited row", () => {
    renderHint();

    const hint = screen.getByTestId(testId(TID_V4_EDIT_IN_COMPOSER_HINT, "42"));
    expect(hint.textContent).toContain("Editing below");
  });

  it("focuses the composer edit bar when clicked", () => {
    const onFocus = vi.fn();
    renderHint(onFocus);

    fireEvent.click(screen.getByTestId(testId(TID_V4_EDIT_IN_COMPOSER_HINT, "42")));

    expect(onFocus).toHaveBeenCalledOnce();
  });
});
