/**
 * 图片标注纯几何层（可单测，不依赖 DOM）。
 *
 * 坐标约定：所有标注点与线宽都使用归一化 0–1 坐标。归一化坐标相对图片内容本身，
 * 与屏幕显示尺寸、缩放倍率、窗口变化无关；导出时再乘回原图自然像素尺寸，
 * 因此缩放或改变窗口大小不会让标注偏移、变形。
 *
 * 线宽 `Annotation.width` 表示「相对图片短边的比例」：屏幕显示时由
 * `strokeWidthPixels` 换回像素，导出时按原图短边换算，保证不同分辨率下视觉一致。
 */
export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** 只包含指针换算需要的矩形字段，便于在 DOM 之外复用。 */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Transform {
  scale: number;
  offset: Point;
}

export interface History<T> {
  past: T[][];
  present: T[];
  future: T[][];
}

export interface AnnotationBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const ANNOTATION_TOOLS = [
  "select",
  "pen",
  "text",
  "rectangle",
  "ellipse",
  "arrow",
  "eraser",
] as const;

export type AnnotationTool = (typeof ANNOTATION_TOOLS)[number];

/** 真正写入标注历史、参与导出的工具。 */
export type DrawableAnnotationTool = Exclude<AnnotationTool, "select" | "eraser">;

export const DRAWABLE_ANNOTATION_TOOLS: readonly DrawableAnnotationTool[] = [
  "pen",
  "text",
  "rectangle",
  "ellipse",
  "arrow",
];

export interface Annotation {
  id: string;
  tool: DrawableAnnotationTool;
  /** 归一化坐标（0–1），首点为起点，末点为当前终点。 */
  points: Point[];
  color: string;
  /** 归一化线宽，相对图片短边；0 表示最小线宽。 */
  width: number;
  text?: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampNormalizedPoint(point: Point): Point {
  return {
    x: clamp(Number.isFinite(point.x) ? point.x : 0, 0, 1),
    y: clamp(Number.isFinite(point.y) ? point.y : 0, 0, 1),
  };
}

/** 自然像素 → 归一化坐标；用于把已有像素数据或指针位置收进统一坐标系。 */
export function toNormalizedPoint(point: Point, size: Size): Point {
  if (!(size.width > 0) || !(size.height > 0)) return { x: 0, y: 0 };
  return clampNormalizedPoint({ x: point.x / size.width, y: point.y / size.height });
}

/** 归一化坐标 → 自然像素；只用于渲染/导出，标注历史仍保持归一化。 */
export function toNaturalPoint(point: Point, size: Size): Point {
  return { x: point.x * size.width, y: point.y * size.height };
}

/** 指针 client 坐标 → 归一化图片坐标（考虑预览容器的实际位移与尺寸）。 */
export function clientPointToNormalized(client: Point, rect: RectLike): Point {
  if (!(rect.width > 0) || !(rect.height > 0)) return { x: 0, y: 0 };
  return clampNormalizedPoint({
    x: (client.x - rect.left) / rect.width,
    y: (client.y - rect.top) / rect.height,
  });
}

/** 归一化线宽转屏幕/导出像素，始终基于图片短边，避免超宽图上的细线。 */
export function strokeWidthPixels(width: number, size: Size): number {
  const base = Math.min(size.width, size.height);
  const scaled = Number.isFinite(width) ? width * (base > 0 ? base : 1) : 0;
  return Math.max(1, scaled);
}

export function annotationBounds(annotation: Annotation): AnnotationBounds {
  if (annotation.points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = annotation.points.map((point) => point.x);
  const ys = annotation.points.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function pointToSegmentDistance(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function polylineDistance(point: Point, points: readonly Point[]): number {
  if (points.length === 0) return Number.POSITIVE_INFINITY;
  if (points.length === 1) return Math.hypot(point.x - points[0]!.x, point.y - points[0]!.y);
  let min = Number.POSITIVE_INFINITY;
  for (let index = 1; index < points.length; index += 1) {
    min = Math.min(min, pointToSegmentDistance(point, points[index - 1]!, points[index]!));
  }
  return min;
}

/**
 * 命中测试：归一化坐标下的点到标注形状的最近距离。
 * `tolerance` 也使用归一化单位（通常由屏幕 3–4px 换算）。选区点击/橡皮擦共用。
 */
export function hitTestAnnotation(
  annotation: Annotation,
  point: Point,
  tolerance = annotation.width * 2,
): boolean {
  const start = annotation.points[0];
  if (!start) return false;
  const end = annotation.points.at(-1) ?? start;
  const slop = Math.max(tolerance, annotation.width / 2);
  if (annotation.tool === "text") {
    // 文字没有独立宽度信息，用起点附近的固定比例包围盒近似；足以支持选择与擦除。
    const size = Math.max(0.02, annotation.width * 10);
    return (
      point.x >= start.x - slop &&
      point.x <= start.x + size + slop &&
      point.y >= start.y - slop &&
      point.y <= start.y + size + slop
    );
  }
  if (annotation.tool === "rectangle") {
    const x0 = Math.min(start.x, end.x);
    const x1 = Math.max(start.x, end.x);
    const y0 = Math.min(start.y, end.y);
    const y1 = Math.max(start.y, end.y);
    const nearX = Math.min(Math.abs(point.x - x0), Math.abs(point.x - x1));
    const nearY = Math.min(Math.abs(point.y - y0), Math.abs(point.y - y1));
    return (
      point.x >= x0 - slop &&
      point.x <= x1 + slop &&
      point.y >= y0 - slop &&
      point.y <= y1 + slop &&
      (nearX <= slop || nearY <= slop)
    );
  }
  if (annotation.tool === "ellipse") {
    const rx = Math.abs(end.x - start.x) / 2;
    const ry = Math.abs(end.y - start.y) / 2;
    if (rx === 0 || ry === 0) return polylineDistance(point, annotation.points) <= slop;
    const cx = (start.x + end.x) / 2;
    const cy = (start.y + end.y) / 2;
    const radius = Math.hypot((point.x - cx) / rx, (point.y - cy) / ry);
    const scaledSlop = slop / Math.min(rx, ry);
    return Math.abs(radius - 1) <= scaledSlop;
  }
  // pen / arrow：都按折线（箭头首尾两点）的距离命中。
  return polylineDistance(point, annotation.points) <= slop;
}

/** 返回点击位置最上层的标注；数组尾部即最后绘制、视觉最上层。 */
export function findTopmostAnnotation(
  annotations: readonly Annotation[],
  point: Point,
  tolerance?: number,
): Annotation | null {
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    const annotation = annotations[index]!;
    if (hitTestAnnotation(annotation, point, tolerance)) return annotation;
  }
  return null;
}

/** 整体平移并限制在图片范围内，避免拖出画布后丢失标注。 */
export function moveAnnotation(annotation: Annotation, delta: Point): Annotation {
  const bounds = annotationBounds(annotation);
  const dx = clamp(delta.x, -bounds.x, 1 - (bounds.x + bounds.width));
  const dy = clamp(delta.y, -bounds.y, 1 - (bounds.y + bounds.height));
  return {
    ...annotation,
    points: annotation.points.map((point) => ({
      x: point.x + dx,
      y: point.y + dy,
    })),
  };
}

/** 预览平移偏移限制：只有图片放大后超出视口的部分才能平移。 */
export function clampOffset(offset: Point, scale: number, image: Size, viewport: Size): Point {
  const x = Math.max(0, (image.width * scale - viewport.width) / 2);
  const y = Math.max(0, (image.height * scale - viewport.height) / 2);
  return {
    x: x ? Math.min(x, Math.max(-x, offset.x)) : 0,
    y: y ? Math.min(y, Math.max(-y, offset.y)) : 0,
  };
}

/** 以视口中心/指针为锚点缩放，保持锚点下的像素不移动。 */
export function zoomAtPoint(transform: Transform, scale: number, anchor: Point): Transform {
  const ratio = scale / transform.scale;
  return {
    scale,
    offset: {
      x: anchor.x - (anchor.x - transform.offset.x) * ratio,
      y: anchor.y - (anchor.y - transform.offset.y) * ratio,
    },
  };
}

export function updateHistory<T>(history: History<T>, present: T[]): History<T> {
  return { past: [...history.past, history.present], present, future: [] };
}

export function undoHistory<T>(history: History<T>): History<T> {
  const previous = history.past.at(-1);
  return previous
    ? {
        past: history.past.slice(0, -1),
        present: previous,
        future: [history.present, ...history.future],
      }
    : history;
}

export function redoHistory<T>(history: History<T>): History<T> {
  const next = history.future[0];
  return next
    ? { past: [...history.past, history.present], present: next, future: history.future.slice(1) }
    : history;
}

interface AnnotationPayload {
  version: 1;
  annotations: Annotation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDrawableTool(value: unknown): value is DrawableAnnotationTool {
  return (
    typeof value === "string" && (DRAWABLE_ANNOTATION_TOOLS as readonly string[]).includes(value)
  );
}

function parsePoint(value: unknown, index: number): Point {
  if (!isRecord(value) || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new Error(`Invalid annotation point at ${index}`);
  }
  return clampNormalizedPoint({ x: value.x as number, y: value.y as number });
}

/**
 * 标注序列化：仅保存编辑器需要的最小字段，并对读取到的数据做归一化校验。
 * 当前运行时标注只活在预览生命周期内；该格式作为契约边界，供后续保存/恢复使用。
 */
export function serializeAnnotations(annotations: readonly Annotation[]): string {
  const payload: AnnotationPayload = {
    version: 1,
    annotations: annotations.map((annotation) => ({
      id: annotation.id,
      tool: annotation.tool,
      points: annotation.points.map((point) => ({ x: point.x, y: point.y })),
      color: annotation.color,
      width: annotation.width,
      ...(annotation.text === undefined ? {} : { text: annotation.text }),
    })),
  };
  return JSON.stringify(payload);
}

export function deserializeAnnotations(raw: string): Annotation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid annotation JSON");
  }
  const source = isRecord(parsed) && "annotations" in parsed ? parsed.annotations : parsed;
  if (!Array.isArray(source)) throw new Error("Invalid annotations payload");
  return source.map((item, index) => {
    if (!isRecord(item)) throw new Error(`Invalid annotation at ${index}`);
    if (typeof item.id !== "string" || item.id.trim().length === 0) {
      throw new Error(`Invalid annotation id at ${index}`);
    }
    if (!isDrawableTool(item.tool)) throw new Error(`Invalid annotation tool at ${index}`);
    if (!Array.isArray(item.points) || item.points.length === 0) {
      throw new Error(`Invalid annotation points at ${index}`);
    }
    if (typeof item.color !== "string" || item.color.trim().length === 0) {
      throw new Error(`Invalid annotation color at ${index}`);
    }
    if (!Number.isFinite(item.width) || (item.width as number) <= 0) {
      throw new Error(`Invalid annotation width at ${index}`);
    }
    if (item.text !== undefined && typeof item.text !== "string") {
      throw new Error(`Invalid annotation text at ${index}`);
    }
    return {
      id: item.id,
      tool: item.tool,
      points: item.points.map((point, pointIndex) => parsePoint(point, pointIndex)),
      color: item.color,
      width: item.width as number,
      ...(item.text === undefined ? {} : { text: item.text }),
    };
  });
}
