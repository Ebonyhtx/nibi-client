import { describe, expect, it } from "vitest";
import {
  MIN_PREVIEW_PANE_HEAVY_CONTENT_VISIBLE_INLINE_SIZE_PX,
  resolveAnimatedSidePanePanelLayout,
  resolveOpenTabLauncherItemIds,
  shouldOfferSelectionSideConversation,
  shouldRenderPreviewPaneHeavyContent,
} from "@/app-shell/animatedSidePanePanelModel.js";
import {
  WORKSPACE_CONVERSATION_COLUMN_MIN_SIZE,
  WORKSPACE_CONVERSATION_COLUMN_REMOTE_MIN_SIZE,
} from "@/app-shell/sidePaneLayout.js";

describe("AnimatedSidePanePanel layout", () => {
  it("lets the desktop side pane expand to the full width while keeping the mobile 0px branch", () => {
    expect(resolveAnimatedSidePanePanelLayout({ mobileOverlay: false })).toEqual({
      collapsedSize: "0px",
      defaultSize: "0px",
      maxSize: "100%",
      minSize: "240px",
      useResizablePanel: true,
    });
    expect(resolveAnimatedSidePanePanelLayout({ mobileOverlay: true })).toEqual({
      collapsedSize: "0px",
      defaultSize: "100%",
      maxSize: "100%",
      minSize: "0px",
      useResizablePanel: false,
    });
  });

  it("uses a fixed 360px conversation-column floor, while remote control keeps the 0px branch", () => {
    expect(WORKSPACE_CONVERSATION_COLUMN_MIN_SIZE).toBe("360px");
    expect(WORKSPACE_CONVERSATION_COLUMN_REMOTE_MIN_SIZE).toBe("0px");
  });

  it("defers heavy PreviewPane content while the active code tab is only a narrow viewport sliver", () => {
    expect(
      shouldRenderPreviewPaneHeavyContent({
        isActiveTab: true,
        isSidePaneVisible: true,
        visibleInlineSizePx: MIN_PREVIEW_PANE_HEAVY_CONTENT_VISIBLE_INLINE_SIZE_PX - 1,
      }),
    ).toBe(false);

    expect(
      shouldRenderPreviewPaneHeavyContent({
        isActiveTab: true,
        isSidePaneVisible: true,
        visibleInlineSizePx: MIN_PREVIEW_PANE_HEAVY_CONTENT_VISIBLE_INLINE_SIZE_PX,
      }),
    ).toBe(true);
  });

  it("defers heavy PreviewPane content while the side pane is settling after resize", () => {
    expect(
      shouldRenderPreviewPaneHeavyContent({
        isActiveTab: true,
        isResizeSettling: true,
        isSidePaneVisible: true,
        visibleInlineSizePx: 480,
      }),
    ).toBe(false);
  });

  it("keeps active media mounted while the side pane is settling after resize", () => {
    expect(
      shouldRenderPreviewPaneHeavyContent({
        isActiveTab: true,
        isMediaPreview: true,
        isResizeSettling: true,
        isSidePaneVisible: true,
        visibleInlineSizePx: 480,
      }),
    ).toBe(true);
  });

  it("still defers inactive or hidden media and media in a narrow pane after settling", () => {
    expect(
      shouldRenderPreviewPaneHeavyContent({
        isActiveTab: false,
        isMediaPreview: true,
        isResizeSettling: true,
        isSidePaneVisible: true,
        visibleInlineSizePx: 480,
      }),
    ).toBe(false);
    expect(
      shouldRenderPreviewPaneHeavyContent({
        isActiveTab: true,
        isMediaPreview: true,
        isSidePaneVisible: false,
        visibleInlineSizePx: 480,
      }),
    ).toBe(false);
    expect(
      shouldRenderPreviewPaneHeavyContent({
        isActiveTab: true,
        isMediaPreview: true,
        isSidePaneVisible: true,
        visibleInlineSizePx: MIN_PREVIEW_PANE_HEAVY_CONTENT_VISIBLE_INLINE_SIZE_PX - 1,
      }),
    ).toBe(false);
  });

  it("keeps PreviewPane heavy content mounted when visibility measurement is unavailable", () => {
    expect(
      shouldRenderPreviewPaneHeavyContent({
        isActiveTab: true,
        isSidePaneVisible: true,
        visibleInlineSizePx: null,
      }),
    ).toBe(true);
    expect(
      shouldRenderPreviewPaneHeavyContent({
        isActiveTab: false,
        isSidePaneVisible: true,
        visibleInlineSizePx: 480,
      }),
    ).toBe(false);
    expect(
      shouldRenderPreviewPaneHeavyContent({
        isActiveTab: true,
        isSidePaneVisible: false,
        visibleInlineSizePx: 480,
      }),
    ).toBe(false);
  });

  it("keeps PreviewPane heavy content mounted inside the mobile overlay drawer", () => {
    expect(
      shouldRenderPreviewPaneHeavyContent({
        isActiveTab: true,
        isMobileOverlay: true,
        isResizeSettling: true,
        isSidePaneVisible: true,
        visibleInlineSizePx: 0,
      }),
    ).toBe(true);
  });

  it("omits the browser launcher item when embedded browser tabs are unsupported", () => {
    expect(
      resolveOpenTabLauncherItemIds({
        developerToolsEnabled: false,
        hasReviewTab: false,
        supportsEmbeddedBrowser: false,
      }),
    ).toEqual(["files", "terminal", "review"]);

    expect(
      resolveOpenTabLauncherItemIds({
        developerToolsEnabled: false,
        hasReviewTab: false,
        supportsEmbeddedBrowser: true,
      }),
    ).toEqual(["files", "browser", "terminal", "review"]);
  });

  it("adds the side conversation launcher only when a desktop parent task is available", () => {
    expect(
      resolveOpenTabLauncherItemIds({
        canOpenSelectionSideConversation: true,
        developerToolsEnabled: false,
        hasReviewTab: false,
      }),
    ).toEqual(["files", "browser", "terminal", "review", "selection-side-conversation"]);
    expect(
      resolveOpenTabLauncherItemIds({
        canOpenSelectionSideConversation: false,
        developerToolsEnabled: false,
        hasReviewTab: false,
      }),
    ).toEqual(["files", "browser", "terminal", "review"]);
  });

  it("hides the side conversation entry without an active task and on mobile", () => {
    expect(
      shouldOfferSelectionSideConversation({
        activeTaskId: "parent-running-or-blocked",
        isMobileTextInputViewport: false,
        mobileOverlay: false,
      }),
    ).toBe(true);
    expect(
      shouldOfferSelectionSideConversation({
        activeTaskId: null,
        isMobileTextInputViewport: false,
        mobileOverlay: false,
      }),
    ).toBe(false);
    expect(
      shouldOfferSelectionSideConversation({
        activeTaskId: "parent-mobile",
        isMobileTextInputViewport: true,
        mobileOverlay: true,
      }),
    ).toBe(false);
  });
});
