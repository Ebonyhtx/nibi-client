// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  canUseImageEditor,
  captureImageComposerTarget,
  clampOffset,
  createImageEditorAttachmentFile,
  decodeImageDataUrl,
  deserializeAnnotations,
  findTopmostAnnotation,
  hitTestAnnotation,
  isAnnotatableImageSource,
  moveAnnotation,
  redoHistory,
  registerImageComposerTarget,
  serializeAnnotations,
  toNaturalPoint,
  toNormalizedPoint,
  undoHistory,
  updateHistory,
  zoomAtPoint,
  type Annotation,
  type ImageEditorOutput,
  type Point,
} from "@/image-preview-editor/index.js";
import { ImagePreviewContent } from "@/previewPaneImageContent.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

const PNG_DATA_URL = "data:image/png;base64,AQID";

function rectangle(overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "rectangle-1",
    tool: "rectangle",
    color: "#ef4444",
    width: 0.004,
    points: [
      { x: 0.1, y: 0.1 },
      { x: 0.4, y: 0.4 },
    ],
    ...overrides,
  };
}

function pen(points: Point[], overrides: Partial<Annotation> = {}): Annotation {
  return {
    id: "pen-1",
    tool: "pen",
    color: "#ef4444",
    width: 0.004,
    points,
    ...overrides,
  };
}

const OUTPUT: ImageEditorOutput = {
  bytes: new Uint8Array([1, 2, 3]),
  mediaType: "image/png",
  filename: "diagram-annotated.png",
  width: 640,
  height: 480,
  changed: true,
};

describe("image editor geometry", () => {
  it("normalizes pointer/natural coordinates and clamps them to the image", () => {
    expect(toNormalizedPoint({ x: 50, y: 25 }, { width: 100, height: 50 })).toEqual({
      x: 0.5,
      y: 0.5,
    });
    expect(toNormalizedPoint({ x: -10, y: 120 }, { width: 100, height: 50 })).toEqual({
      x: 0,
      y: 1,
    });
    expect(toNormalizedPoint({ x: 10, y: 10 }, { width: 0, height: 0 })).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("keeps annotations anchored when the display size changes", () => {
    const point = { x: 0.25, y: 0.75 };
    for (const size of [
      { width: 320, height: 200 },
      { width: 1920, height: 1200 },
    ]) {
      expect(toNormalizedPoint(toNaturalPoint(point, size), size)).toEqual(point);
    }
  });

  it("clamps pan offsets so the image cannot be dragged off-screen", () => {
    expect(
      clampOffset(
        { x: 999, y: -999 },
        1,
        { width: 1000, height: 500 },
        { width: 500, height: 500 },
      ),
    ).toEqual({ x: 250, y: 0 });
  });

  it("keeps the zoom anchor fixed after zooming", () => {
    const anchor = { x: 100, y: 50 };
    const next = zoomAtPoint({ scale: 1, offset: { x: 0, y: 0 } }, 2, anchor);
    expect(next).toEqual({ scale: 2, offset: { x: -100, y: -50 } });
    // 锚点下的内容在缩放前后仍落在同一屏幕位置。
    expect(anchor.x * next.scale + next.offset.x).toBe(anchor.x);
    expect(anchor.y * next.scale + next.offset.y).toBe(anchor.y);
  });

  it("hit-tests strokes and selections in normalized space", () => {
    const stroke = pen([
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.1 },
    ]);
    expect(hitTestAnnotation(stroke, { x: 0.5, y: 0.12 }, 0.05)).toBe(true);
    expect(hitTestAnnotation(stroke, { x: 0.5, y: 0.5 }, 0.05)).toBe(false);

    const box = rectangle();
    expect(hitTestAnnotation(box, { x: 0.25, y: 0.1 }, 0.02)).toBe(true);
    expect(hitTestAnnotation(box, { x: 0.25, y: 0.25 }, 0.02)).toBe(false);

    const topmost = { ...box, id: "rectangle-2" };
    expect(findTopmostAnnotation([box, topmost], { x: 0.25, y: 0.1 }, 0.02)?.id).toBe(
      "rectangle-2",
    );
  });

  it("moves annotations without leaving the image bounds", () => {
    const edge = rectangle({
      points: [
        { x: 0.8, y: 0.8 },
        { x: 0.9, y: 0.9 },
      ],
    });
    expect(moveAnnotation(edge, { x: 0.5, y: 0.5 }).points).toEqual([
      { x: 0.9, y: 0.9 },
      { x: 1, y: 1 },
    ]);
    expect(moveAnnotation(edge, { x: -2, y: -2 }).points[0]).toEqual({ x: 0, y: 0 });
    const moved = moveAnnotation(edge, { x: -2, y: -2 }).points[1]!;
    expect(moved.x).toBeCloseTo(0.1);
    expect(moved.y).toBeCloseTo(0.1);
  });
});

describe("annotation history and serialization", () => {
  const first = rectangle();
  const second = pen([
    { x: 0.2, y: 0.2 },
    { x: 0.6, y: 0.6 },
  ]);

  it("undoes and redoes annotation snapshots", () => {
    let history = { past: [], present: [], future: [] } as {
      past: Annotation[][];
      present: Annotation[];
      future: Annotation[][];
    };
    history = updateHistory(history, [first]);
    history = updateHistory(history, [first, second]);
    expect(undoHistory(history).present).toEqual([first]);
    expect(redoHistory(undoHistory(history)).present).toEqual([first, second]);
    expect(undoHistory({ past: [], present: [], future: [] })).toEqual({
      past: [],
      present: [],
      future: [],
    });
  });

  it("round-trips serialized annotations and clamps untrusted points", () => {
    const restored = deserializeAnnotations(serializeAnnotations([first, second]));
    expect(restored).toEqual([first, second]);

    const clamped = deserializeAnnotations(
      JSON.stringify([{ ...first, points: [{ x: 2, y: -1 }] }]),
    );
    expect(clamped[0]?.points).toEqual([{ x: 1, y: 0 }]);
  });

  it("rejects malformed annotation payloads", () => {
    expect(() => deserializeAnnotations("not json")).toThrow();
    expect(() => deserializeAnnotations(JSON.stringify({ annotations: "nope" }))).toThrow();
    expect(() => deserializeAnnotations(JSON.stringify([{ ...first, tool: "select" }]))).toThrow();
    expect(() => deserializeAnnotations(JSON.stringify([{ ...first, points: [] }]))).toThrow();
  });
});

describe("image editor composer target", () => {
  it("delivers the annotated PNG payload through the registered target", () => {
    const events = new EventTarget();
    const received: ImageEditorOutput[] = [];
    const release = registerImageComposerTarget(
      {
        target: {
          appendImage: (output) => {
            received.push(output);
            return true;
          },
        },
      },
      events,
    );

    const target = captureImageComposerTarget({ events });
    expect(target).not.toBeNull();
    expect(target?.appendImage(OUTPUT)).toBe(true);
    expect(received).toEqual([OUTPUT]);

    const file = createImageEditorAttachmentFile(OUTPUT);
    expect(file.name).toBe("diagram-annotated.png");
    expect(file.type).toBe("image/png");
    expect(file.size).toBe(3);

    release();
    expect(captureImageComposerTarget({ events })).toBeNull();
  });

  it("only lets the first registered target claim a request", () => {
    const events = new EventTarget();
    const first: ImageEditorOutput[] = [];
    const second: ImageEditorOutput[] = [];
    const releaseFirst = registerImageComposerTarget(
      { target: { appendImage: (output) => (first.push(output), true) } },
      events,
    );
    const releaseSecond = registerImageComposerTarget(
      { target: { appendImage: (output) => (second.push(output), true) } },
      events,
    );

    captureImageComposerTarget({ events })?.appendImage(OUTPUT);
    expect(first).toEqual([OUTPUT]);
    expect(second).toEqual([]);

    releaseFirst();
    releaseSecond();
  });

  it("routes a scoped request to the matching session/draft composer", () => {
    const events = new EventTarget();
    const first: ImageEditorOutput[] = [];
    const second: ImageEditorOutput[] = [];
    const primaryScope = {
      sessionId: "session-a",
      workspaceKey: "/workspace",
      draftScopeKey: "draft-a",
    };
    const sideScope = {
      sessionId: "session-b",
      workspaceKey: "/workspace",
      draftScopeKey: "draft-b",
    };
    const releaseFirst = registerImageComposerTarget(
      {
        scope: primaryScope,
        target: { appendImage: (output) => (first.push(output), true) },
      },
      events,
    );
    const releaseSecond = registerImageComposerTarget(
      {
        scope: sideScope,
        target: { appendImage: (output) => (second.push(output), true) },
      },
      events,
    );

    expect(
      captureImageComposerTarget({
        events,
        // 活跃会话只按 sessionId 归属；预览侧带的草稿键不参与匹配。
        scope: { ...sideScope, draftScopeKey: "stale-draft" },
      })?.appendImage(OUTPUT),
    ).toBe(true);
    expect(first).toEqual([]);
    expect(second).toEqual([OUTPUT]);

    // 预览所属会话已不在 focused 集合时返回 null，不能退化为写到其它 pane。
    expect(
      captureImageComposerTarget({
        events,
        scope: { ...primaryScope, sessionId: "session-closed" },
      }),
    ).toBeNull();

    releaseFirst();
    releaseSecond();
  });

  it("uses the project draft scope only when no session is active", () => {
    const events = new EventTarget();
    const received: ImageEditorOutput[] = [];
    const release = registerImageComposerTarget(
      {
        scope: { sessionId: null, workspaceKey: "/workspace", draftScopeKey: "draft-a" },
        target: { appendImage: (output) => (received.push(output), true) },
      },
      events,
    );

    expect(
      captureImageComposerTarget({
        events,
        scope: { sessionId: null, workspaceKey: "/workspace", draftScopeKey: "draft-b" },
      }),
    ).toBeNull();
    expect(
      captureImageComposerTarget({
        events,
        scope: { sessionId: null, workspaceKey: "/workspace", draftScopeKey: "draft-a" },
      })?.appendImage(OUTPUT),
    ).toBe(true);
    expect(received).toEqual([OUTPUT]);

    release();
  });
});

describe("image editor entry capability", () => {
  it("requires both a desktop host and canvas export support", () => {
    expect(canUseImageEditor({ desktopHost: true, canvas: true })).toBe(true);
    expect(canUseImageEditor({ desktopHost: false, canvas: true })).toBe(false);
    expect(canUseImageEditor({ desktopHost: true, canvas: false })).toBe(false);
  });

  it("does not render the annotate entry without a desktop platform", () => {
    const html = renderToStaticMarkup(
      createElement(ImagePreviewContent, {
        title: "diagram.png",
        imageSource: PNG_DATA_URL,
      }),
    );
    expect(html).not.toContain("data-image-preview-annotate");
    expect(html).not.toContain("imageEditor.annotate");
  });

  it("decodes base64 image data URLs and rejects unsupported encodings", () => {
    expect(decodeImageDataUrl(PNG_DATA_URL)).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
    });
    expect(decodeImageDataUrl("data:image/png,not-base64")).toBeNull();
    expect(decodeImageDataUrl("data:text/plain;base64,AQID")).toBeNull();
    expect(decodeImageDataUrl("https://example.com/diagram.png")).toBeNull();
  });

  it("only offers annotation for base64 raster sources", () => {
    expect(isAnnotatableImageSource(PNG_DATA_URL)).toBe(true);
    expect(isAnnotatableImageSource("data:image/svg+xml;charset=utf-8,%3Csvg%3E")).toBe(false);
    expect(isAnnotatableImageSource("blob:preview")).toBe(false);
  });
});
