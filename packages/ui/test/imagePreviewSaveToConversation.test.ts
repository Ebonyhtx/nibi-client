// @vitest-environment jsdom

import type { IPlatformService } from "@nibi/shared";
import { createElement, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImagePreviewDialog } from "@/components/ai-elements/image-preview-dialog.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";
import {
  createImageEditorAttachmentFile,
  registerImageComposerTarget,
  type ImageEditorComposerScope,
  type ImageEditorOutput,
} from "@/image-preview-editor/index.js";

const mocks = vi.hoisted(() => ({
  exportAnnotatedImage: vi.fn(),
  toast: vi.fn(),
}));

// 保存链路本身（capture → createImageEditorAttachmentFile → addAttachmentFiles）保持真实；
// jsdom 没有 2D canvas，只替换栅格化导出与能力探测，避免把待验证的捕获/投递逻辑一起 mock。
vi.mock("@/image-preview-editor/annotations.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/image-preview-editor/annotations.js")>();
  return { ...actual, exportAnnotatedImage: mocks.exportAnnotatedImage };
});
vi.mock("@/image-preview-editor/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/image-preview-editor/index.js")>();
  return { ...actual, detectImageEditorCanvas: () => true };
});
vi.mock("@/components/ui/toast.js", () => ({ toast: mocks.toast }));
vi.mock("@/logger.js", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const PNG_DATA_URL = "data:image/png;base64,AQID";
const ANNOTATED_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 8]);
const SCOPE: ImageEditorComposerScope = { sessionId: "session-a", workspaceKey: "/workspace" };

let releaseComposerTarget: (() => void) | undefined;

function createPlatform(): IPlatformService {
  return { canOpenLocalFiles: true } as unknown as IPlatformService;
}

function PreviewHarness({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const [open, setOpen] = useState(true);
  return createElement(ImagePreviewDialog, {
    composerScope: SCOPE,
    dialogTestId: "image-preview-save-dialog",
    imageTestId: "image-preview-save-image",
    initialIndex: 0,
    items: [
      {
        alt: "diagram.png",
        filename: "diagram.png",
        mediaType: "image/png",
        src: PNG_DATA_URL,
      },
    ],
    onOpenChange: (next: boolean) => {
      onOpenChange(next);
      setOpen(next);
    },
    open,
  });
}

function mountPreview(onOpenChange: (open: boolean) => void) {
  render(
    createElement(
      NibiIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(
        PlatformProvider,
        { platform: createPlatform() },
        createElement(PreviewHarness, { onOpenChange }),
      ),
    ),
  );
}

function saveButton() {
  return screen.getByRole("button", { name: "保存到对话" }) as HTMLButtonElement;
}

async function enterEditor() {
  const previewImage = screen.getByTestId("image-preview-save-image") as HTMLImageElement;
  // jsdom 不解析图片，自然尺寸由测试注入；编辑器只用它生成导出画布尺寸。
  Object.defineProperty(previewImage, "naturalWidth", { configurable: true, value: 4 });
  Object.defineProperty(previewImage, "naturalHeight", { configurable: true, value: 3 });

  fireEvent.click(screen.getByRole("button", { name: "编辑图片" }));

  const editorImage = await waitFor(() => {
    const node = document.querySelector<HTMLImageElement>("[data-image-editor-image]");
    expect(node).not.toBeNull();
    return node as HTMLImageElement;
  });
  // 编辑器等待真实 onLoad 才允许导出；jsdom 不会自行加载 blob URL。
  fireEvent.load(editorImage);
  await waitFor(() => expect(saveButton()).toBeTruthy());
}

function drawPenStroke() {
  fireEvent.click(document.querySelector('[data-image-editor-tool="pen"]') as HTMLButtonElement);
  const surface = document.querySelector<HTMLDivElement>("[data-image-editor-surface]");
  expect(surface).not.toBeNull();
  Object.defineProperty(surface, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: 100,
      height: 100,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  });
  Object.defineProperties(surface as HTMLDivElement, {
    hasPointerCapture: { configurable: true, value: vi.fn(() => false) },
    releasePointerCapture: { configurable: true, value: vi.fn() },
    setPointerCapture: { configurable: true, value: vi.fn() },
  });

  fireEvent.pointerDown(surface as HTMLDivElement, {
    button: 0,
    clientX: 10,
    clientY: 10,
    pointerId: 11,
  });
  fireEvent.pointerMove(surface as HTMLDivElement, {
    clientX: 80,
    clientY: 80,
    pointerId: 11,
  });
  fireEvent.pointerUp(surface as HTMLDivElement, {
    clientX: 80,
    clientY: 80,
    pointerId: 11,
  });
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  mocks.exportAnnotatedImage.mockReset();
  mocks.exportAnnotatedImage.mockImplementation(
    async (
      _image: HTMLImageElement,
      _overlay: SVGSVGElement,
      options: { width: number; height: number; filename: string; changed: boolean },
    ) => ({
      bytes: ANNOTATED_PNG,
      mediaType: "image/png" as const,
      filename: `${options.filename.replace(/\.[a-z0-9]+$/iu, "")}-annotated.png`,
      width: options.width,
      height: options.height,
      changed: options.changed,
    }),
  );
  mocks.toast.mockReset();
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => "blob:editor-image");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

afterEach(() => {
  releaseComposerTarget?.();
  releaseComposerTarget = undefined;
  cleanup();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("image preview edit -> save to conversation", () => {
  it("delivers the annotated PNG as a composer attachment and closes the preview", async () => {
    const addAttachmentFiles = vi.fn((files: File[]) => files.map((file) => file.name));
    const received: ImageEditorOutput[] = [];
    releaseComposerTarget = registerImageComposerTarget({
      scope: SCOPE,
      target: {
        appendImage: (output) => {
          received.push(output);
          return addAttachmentFiles([createImageEditorAttachmentFile(output)]).length > 0;
        },
      },
    });

    const onOpenChange = vi.fn();
    mountPreview(onOpenChange);
    await enterEditor();
    expect(mocks.exportAnnotatedImage).not.toHaveBeenCalled();

    drawPenStroke();
    await waitFor(() => expect(saveButton().disabled).toBe(false));

    fireEvent.click(saveButton());

    await waitFor(() => expect(addAttachmentFiles).toHaveBeenCalledTimes(1));
    const files = addAttachmentFiles.mock.calls[0]?.[0] ?? [];
    expect(files).toHaveLength(1);
    expect(files[0]).toBeInstanceOf(File);
    expect(files[0]?.type).toBe("image/png");
    expect(files[0]?.name).toBe("diagram-annotated.png");
    expect(files[0]?.size).toBe(ANNOTATED_PNG.byteLength);

    expect(received).toHaveLength(1);
    expect(received[0]?.changed).toBe(true);
    expect(received[0]?.mediaType).toBe("image/png");
    expect(received[0]?.bytes).toEqual(ANNOTATED_PNG);
    expect(mocks.exportAnnotatedImage).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    await waitFor(() => expect(screen.queryByTestId("image-preview-save-dialog")).toBeNull());
    expect(mocks.toast).toHaveBeenCalledWith("已保存到对话");
  });

  it("stays open and reports no composer instead of pretending the save succeeded", async () => {
    const onOpenChange = vi.fn();
    mountPreview(onOpenChange);
    await enterEditor();

    drawPenStroke();
    await waitFor(() => expect(saveButton().disabled).toBe(false));

    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(expect.stringContaining("没有可用的输入框")),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByTestId("image-preview-save-dialog")).toBeTruthy();
    // 没有接收方时在导出前就停止，不产生“已保存”假象。
    expect(mocks.exportAnnotatedImage).not.toHaveBeenCalled();
  });
});
