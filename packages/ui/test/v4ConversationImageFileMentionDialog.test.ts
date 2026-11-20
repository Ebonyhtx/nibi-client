// @vitest-environment jsdom

import { createElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ServiceProvider } from "@/hooks/useServices.js";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationUserInputContent } from "@/v4/ConversationUserInputContent.js";
import { ImageFilePreviewScopeContext } from "@/v4/imageFilePreviewContext.js";

function renderMention(
  text: string,
  readMediaPreview: (params: { path: string }) => Promise<never>,
) {
  return render(
    createElement(
      NibiIntlProvider,
      { initialLocale: "en-US" },
      createElement(
        ServiceProvider,
        { services: { fileService: { readMediaPreview } } as never },
        createElement(
          ImageFilePreviewScopeContext.Provider,
          { value: { workspacePath: "/workspace" } },
          createElement(ConversationUserInputContent, { text }),
        ),
      ),
    ),
  );
}

describe("image file mention preview dialog failures", () => {
  it("renders the shared dialog error state instead of a blank preview", async () => {
    const readMediaPreview = vi.fn().mockRejectedValue(new Error("file not found"));
    const view = renderMention("[missing.png](./images/missing.png)", readMediaPreview);

    fireEvent.click(view.container.querySelector("[data-image-file-mention]") as HTMLButtonElement);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("no longer available"),
    );
    expect(readMediaPreview).toHaveBeenCalledWith({ path: "/workspace/images/missing.png" });
    expect(view.container.querySelector("[data-image-preview-surface] img")).toBeNull();
  });
});
