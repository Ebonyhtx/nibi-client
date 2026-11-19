// @vitest-environment jsdom

import { createElement, useRef, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";
import {
  ImagePreviewActions,
  getImagePreviewActionAvailability,
} from "@/image-preview-editor/ImagePreviewActions.js";
import {
  registerImageComposerTarget,
  type ImageEditorComposerScope,
  type ImageEditorOutput,
} from "@/image-preview-editor/index.js";

const mocks = vi.hoisted(() => ({
  copyPreviewImage: vi.fn(),
  downloadImagePreview: vi.fn(),
  encodePreviewImagePng: vi.fn(),
  readBoundedImageBlob: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/image-preview-editor/copyImage.js", () => ({
  copyPreviewImage: mocks.copyPreviewImage,
  encodePreviewImagePng: mocks.encodePreviewImagePng,
}));
vi.mock("@/image-preview-editor/imagePreviewDownload.js", () => ({
  downloadImagePreview: mocks.downloadImagePreview,
  readBoundedImageBlob: mocks.readBoundedImageBlob,
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: mocks.toast }));
vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const platformState = vi.hoisted(() => ({
  value: undefined as unknown,
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  useOptionalPlatform: () => platformState.value,
}));

const ITEM = {
  alt: "diagram.png",
  filename: "diagram.png",
  mediaType: "image/png",
  src: "data:image/png;base64,AQID",
};
const SCOPE: ImageEditorComposerScope = { sessionId: "session-a", workspaceKey: "/workspace" };

let releaseComposerTarget: (() => void) | undefined;

function nativePlatform() {
  return {
    canOpenLocalFiles: true,
    openExternalFile: vi.fn(async () => ({ success: true })),
    saveFile: vi.fn(async () => ({ success: true, path: "/saved/diagram.png" })),
  };
}

function Harness({
  canDraw = true,
  onAdded = vi.fn(),
  onDraw = vi.fn(),
  ready = true,
}: {
  canDraw?: boolean;
  onAdded?: () => void;
  onDraw?: () => void;
  ready?: boolean;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  return createElement(
    "div",
    null,
    createElement("img", { alt: "diagram.png", "data-testid": "action-image", ref: imageRef }),
    createElement(ImagePreviewActions, {
      canDraw,
      composerScope: SCOPE,
      imageRef,
      item: ITEM,
      onAdded,
      onDraw,
      ready,
      children: createElement("button", { type: "button" }, "close") as ReactNode,
    }),
  );
}

function mount(props: Parameters<typeof Harness>[0] = {}) {
  return render(createElement(NibiIntlProvider, { initialLocale: "zh-CN" }, createElement(Harness, props)));
}

function action(name: string) {
  return document.querySelector<HTMLButtonElement>(`button[data-image-preview-action="${name}"]`);
}

beforeEach(() => {
  mocks.copyPreviewImage.mockReset();
  mocks.copyPreviewImage.mockResolvedValue(undefined);
  mocks.downloadImagePreview.mockReset();
  mocks.downloadImagePreview.mockResolvedValue({ kind: "saved", path: "/saved/diagram.png" });
  mocks.encodePreviewImagePng.mockReset();
  mocks.encodePreviewImagePng.mockResolvedValue({
    arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
  } as Blob);
  mocks.readBoundedImageBlob.mockReset();
  mocks.readBoundedImageBlob.mockResolvedValue(
    new Blob([new Uint8Array([4, 5, 6])], { type: "image/jpeg" }),
  );
  mocks.toast.mockReset();
  platformState.value = nativePlatform();
});

afterEach(() => {
  cleanup();
  releaseComposerTarget?.();
  releaseComposerTarget = undefined;
});

describe("image preview action availability", () => {
  it("gates actions by source, load state, draw capability and native open capability", () => {
    expect(
      getImagePreviewActionAvailability({
        canDraw: true,
        hasSource: true,
        nativeOpen: true,
        ready: true,
      }),
    ).toEqual({
      addToConversation: true,
      copy: true,
      draw: true,
      saveAndOpen: true,
      saveAs: true,
    });
    expect(
      getImagePreviewActionAvailability({
        canDraw: false,
        hasSource: true,
        nativeOpen: false,
        ready: true,
      }),
    ).toEqual({
      addToConversation: true,
      copy: true,
      draw: false,
      saveAndOpen: false,
      saveAs: true,
    });
    expect(
      getImagePreviewActionAvailability({
        canDraw: true,
        hasSource: false,
        nativeOpen: true,
        ready: true,
      }),
    ).toMatchObject({ addToConversation: false, copy: false, saveAs: false, saveAndOpen: false });
    expect(
      getImagePreviewActionAvailability({
        canDraw: true,
        hasSource: true,
        nativeOpen: true,
        ready: false,
      }),
    ).toEqual({
      addToConversation: false,
      copy: false,
      draw: false,
      saveAndOpen: false,
      saveAs: true,
    });
  });

  it("hides save-and-open on web while keeping save-as", () => {
    platformState.value = { canOpenLocalFiles: false };
    mount();
    expect(action("saveAndOpen")).toBeNull();
    expect(action("saveAs")).not.toBeNull();
    expect(action("copy")).not.toBeNull();
    expect(action("add")).not.toBeNull();
    expect(action("draw")).not.toBeNull();
    expect(action("more")).not.toBeNull();
  });

  it("hides draw when the editor capability is unavailable", () => {
    mount({ canDraw: false });
    expect(action("draw")).toBeNull();
  });

  it("hides pixel actions until the preview image has loaded but keeps save-as", () => {
    mount({ ready: false });
    expect(action("saveAs")?.disabled).toBe(false);
    expect(action("copy")).toBeNull();
    expect(action("add")).toBeNull();
    expect(action("draw")).toBeNull();
    expect(action("more")).not.toBeNull();
  });
});

describe("image preview action callbacks", () => {
  it("saves as a local copy and reports completion", async () => {
    mount();
    fireEvent.click(action("saveAs")!);
    await waitFor(() => expect(mocks.downloadImagePreview).toHaveBeenCalledOnce());
    expect(mocks.downloadImagePreview.mock.calls[0]?.[0]).toEqual(ITEM);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("下载成功"));
  });

  it("saves a copy first and opens it with the default application", async () => {
    const platform = nativePlatform();
    platformState.value = platform;
    mount();
    fireEvent.click(action("saveAndOpen")!);
    await waitFor(() => expect(platform.openExternalFile).toHaveBeenCalledWith("/saved/diagram.png"));
  });

  it("copies the loaded image and reports success", async () => {
    mount();
    const image = screen.getByTestId("action-image") as HTMLImageElement;
    fireEvent.click(action("copy")!);
    await waitFor(() => expect(mocks.copyPreviewImage).toHaveBeenCalledWith(image));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("图片已复制"));
  });

  it("adds the original image file through the composer target", async () => {
    let appendedFile: File | undefined;
    releaseComposerTarget = registerImageComposerTarget({
      scope: SCOPE,
      target: {
        appendFile: (file) => {
          appendedFile = file;
          return true;
        },
        appendImage: () => false,
      },
    });
    const onAdded = vi.fn();
    mount({ onAdded });
    fireEvent.click(action("add")!);
    await waitFor(() => expect(appendedFile).toBeDefined());
    expect(appendedFile).toMatchObject({ name: "diagram.jpg", type: "image/jpeg" });
    expect(new Uint8Array(await appendedFile!.arrayBuffer())).toEqual(new Uint8Array([4, 5, 6]));
    expect(mocks.toast).toHaveBeenCalledWith("已添加到聊天");
    expect(onAdded).toHaveBeenCalledOnce();
  });

  it("falls back to an annotated PNG target when appendFile is unavailable", async () => {
    let appended: ImageEditorOutput | undefined;
    releaseComposerTarget = registerImageComposerTarget({
      scope: SCOPE,
      target: {
        appendImage: (output) => {
          appended = output;
          return true;
        },
      },
    });
    mount();
    fireEvent.click(action("add")!);
    await waitFor(() => expect(appended).toBeDefined());
    expect(appended).toMatchObject({
      bytes: new Uint8Array([1, 2, 3]),
      changed: false,
      filename: "diagram.png",
      mediaType: "image/png",
    });
  });

  it("calls the draw callback", () => {
    const onDraw = vi.fn();
    mount({ onDraw });
    fireEvent.click(action("draw")!);
    expect(onDraw).toHaveBeenCalledOnce();
  });

  it("lists every action in the more menu", async () => {
    mount();
    fireEvent.pointerDown(action("more")!, { button: 0, ctrlKey: false });
    await waitFor(() => expect(screen.getAllByRole("menuitem")).toHaveLength(5));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "保存并打开",
      "另存为",
      "复制图片",
      "添加到聊天",
      "绘制",
    ]);
  });
});

describe("image preview action failure feedback", () => {
  it("reports a copy failure instead of staying silent", async () => {
    mocks.copyPreviewImage.mockRejectedValue(new Error("clipboard denied"));
    mount();
    fireEvent.click(action("copy")!);
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith("复制图片失败，请检查剪贴板权限后重试。"),
    );
  });

  it("reports a save failure", async () => {
    mocks.downloadImagePreview.mockRejectedValue(new Error("disk full"));
    mount();
    fireEvent.click(action("saveAs")!);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("下载图片失败"));
  });

  it("reports an open failure after saving", async () => {
    const platform = nativePlatform();
    platform.openExternalFile.mockResolvedValue({ error: "no default app", success: false });
    platformState.value = platform;
    mount();
    fireEvent.click(action("saveAndOpen")!);
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith("图片操作失败，请重试"));
  });

  it("reports a missing composer target instead of adding to another conversation", async () => {
    mount();
    fireEvent.click(action("add")!);
    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith("没有可用的输入框，请先打开会话输入区。"),
    );
  });
});
