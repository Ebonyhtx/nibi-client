import type { ImageEditorOutput } from "./contract.js";
import {
  annotationBounds,
  strokeWidthPixels,
  toNaturalPoint,
  type Annotation,
  type Size,
} from "./geometry.js";

/** 导出画布上限：与预览复制图片保持同一安全边界，避免一次性占用过大内存。 */
const MAX_EXPORT_PIXELS = 32_000_000;

/** 把归一化标注换算成自然像素后绘制；屏幕缩放只影响外层 CSS transform。 */
export function AnnotationShape({ annotation, size }: { annotation: Annotation; size: Size }) {
  const { points, tool, color, width, text } = annotation;
  const start = points[0]!;
  const end = points.at(-1)!;
  const stroke = strokeWidthPixels(width, size);
  if (tool === "text") {
    const origin = toNaturalPoint(start, size);
    return (
      <text
        x={origin.x}
        y={origin.y}
        fill={color}
        stroke="none"
        fontFamily="sans-serif"
        fontSize={stroke * 6}
        dominantBaseline="hanging"
      >
        {text}
      </text>
    );
  }
  if (tool === "rectangle") {
    const a = toNaturalPoint(start, size);
    const b = toNaturalPoint(end, size);
    return (
      <rect
        x={Math.min(a.x, b.x)}
        y={Math.min(a.y, b.y)}
        width={Math.abs(b.x - a.x)}
        height={Math.abs(b.y - a.y)}
      />
    );
  }
  if (tool === "ellipse") {
    const a = toNaturalPoint(start, size);
    const b = toNaturalPoint(end, size);
    const widthPx = Math.abs(b.x - a.x);
    const heightPx = Math.abs(b.y - a.y);
    return (
      <ellipse
        cx={Math.min(a.x, b.x) + widthPx / 2}
        cy={Math.min(a.y, b.y) + heightPx / 2}
        rx={widthPx / 2}
        ry={heightPx / 2}
      />
    );
  }
  if (tool === "arrow") {
    const a = toNaturalPoint(start, size);
    const b = toNaturalPoint(end, size);
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const head = stroke * 4;
    return (
      <path
        d={`M${a.x},${a.y} L${b.x},${b.y} M${b.x - head * Math.cos(angle - 0.5)},${b.y - head * Math.sin(angle - 0.5)} L${b.x},${b.y} L${b.x - head * Math.cos(angle + 0.5)},${b.y - head * Math.sin(angle + 0.5)}`}
      />
    );
  }
  if (points.length === 1) {
    const origin = toNaturalPoint(start, size);
    return <circle cx={origin.x} cy={origin.y} r={stroke / 2} fill={color} stroke="none" />;
  }
  return (
    <polyline
      points={points
        .map((point) => {
          const natural = toNaturalPoint(point, size);
          return `${natural.x},${natural.y}`;
        })
        .join(" ")}
    />
  );
}

export function AnnotationLayer({
  annotations,
  selected,
  size,
}: {
  annotations: readonly Annotation[];
  selected: string | null;
  size: Size;
}) {
  return (
    <>
      {annotations.map((annotation) => {
        const bounds = annotationBounds(annotation);
        const padding = strokeWidthPixels(annotation.width, size) * 2;
        return (
          <g
            key={annotation.id}
            data-annotation-id={annotation.id}
            stroke={annotation.color}
            fill="none"
            strokeWidth={strokeWidthPixels(annotation.width, size)}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ pointerEvents: "visiblePainted" }}
          >
            <AnnotationShape annotation={annotation} size={size} />
            {selected === annotation.id ? (
              <rect
                data-selection=""
                x={bounds.x * size.width - padding}
                y={bounds.y * size.height - padding}
                width={Math.max(padding * 2, bounds.width * size.width + padding * 2)}
                height={Math.max(padding * 2, bounds.height * size.height + padding * 2)}
                stroke="currentColor"
                strokeDasharray="4 4"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
            ) : null}
          </g>
        );
      })}
    </>
  );
}

export interface ExportAnnotatedImageOptions {
  width: number;
  height: number;
  filename: string;
  changed: boolean;
}

function sanitizeExportBaseName(filename: string): string {
  return (
    filename
      .replace(/\.[a-z0-9]+$/iu, "")
      .replace(/[<>:"/\\|?*\p{Cc}]/gu, "-")
      .slice(0, 80) || "image"
  );
}

/**
 * 只栅格化原图与标注层，不使用屏幕截图：避免缩放、主题背景、棋盘格污染输出像素。
 * 标注坐标是归一化的，因此这里按输入的自然尺寸重建画布，导出结果与当前窗口大小无关。
 */
export async function exportAnnotatedImage(
  image: HTMLImageElement,
  overlay: SVGSVGElement,
  options: ExportAnnotatedImageOptions,
): Promise<ImageEditorOutput> {
  const { width, height } = options;
  if (!(width > 0) || !(height > 0) || width * height > MAX_EXPORT_PIXELS) {
    throw new Error("Image dimensions exceed the export limit");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.drawImage(image, 0, 0, width, height);

  const clone = overlay.cloneNode(true) as SVGSVGElement;
  clone.querySelectorAll("[data-selection]").forEach((element) => element.remove());
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(width));
  clone.setAttribute("height", String(height));
  clone.setAttribute("viewBox", `0 0 ${width} ${height}`);
  clone.removeAttribute("class");
  clone.removeAttribute("style");

  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }),
  );
  try {
    const layer = new Image();
    layer.src = url;
    await layer.decode();
    context.drawImage(layer, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("PNG export failed"))),
        "image/png",
      ),
    );
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      mediaType: "image/png",
      filename: `${sanitizeExportBaseName(options.filename)}-annotated.png`,
      width,
      height,
      changed: options.changed,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}
