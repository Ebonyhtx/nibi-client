import type { ToolExecutionContext } from "../types.js";
import { MAX_MODEL_INPUT_CHARS, WEBFETCH_TOOL_NAME } from "./webfetch-constants.js";
import { webFetchError } from "./webfetch-errors.js";
import { traceFromContext } from "./webfetch-trace.js";

export function extractReadableContent(body: Uint8Array, contentType: string): string {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!isTextLikeMime(mime)) {
    throw webFetchError("FetchFailed", `Unsupported WebFetch content type: ${mime || "unknown"}`, {
      contentType,
    });
  }

  const text = new TextDecoder().decode(body);
  if (mime === "text/html" || mime === "application/xhtml+xml" || contentType.includes("html")) {
    return htmlToMarkdown(text);
  }
  return text.trim();
}

export async function maybePersistRawContent(
  content: string,
  contentType: string,
  context: ToolExecutionContext,
): Promise<{ path?: string; uri: string } | undefined> {
  if (!context.artifactStore) return undefined;
  if (Buffer.byteLength(content, "utf8") <= MAX_MODEL_INPUT_CHARS) return undefined;

  const artifact = await context.artifactStore.writeToolResultArtifact(
    {
      sessionId: context.sessionId,
      turnId: context.turnId,
      toolCallId: context.toolCallId,
      toolName: WEBFETCH_TOOL_NAME,
      content,
      contentType: contentType.includes("html") ? "text/markdown" : "text/plain",
      retention: "session",
      trace: traceFromContext(context),
    },
    { signal: context.abortSignal },
  );

  return { path: artifact.path, uri: artifact.uri };
}

/**
 * `offset` 的正文窗口：从第 `offset` 个字符起的剩余正文，以及整页字符数。
 * `offset` 按 Unicode 标量计数，与 Rust 内核 `WebFetch` 的 `chars()` 口径一致；
 * 这样模型在两侧内核之间复用续读值时落点相同。
 */
export interface WebFetchContentWindow {
  content: string;
  offset: number;
  total: number;
  pastEnd: boolean;
}

export function sliceContentFromOffset(content: string, offset: number): WebFetchContentWindow {
  const start = Number.isFinite(offset) && offset > 0 ? Math.trunc(offset) : 0;
  if (start === 0) return { content, offset: 0, total: 0, pastEnd: false };
  const chars = Array.from(content);
  const clamped = Math.min(start, chars.length);
  return {
    content: chars.slice(clamped).join(""),
    // 报错/续读提示用调用方给的 offset（Rust `past_end` 同口径），裁剪才用 clamp 后的位置。
    offset: start,
    total: chars.length,
    pastEnd: clamped >= chars.length,
  };
}

/** `offset` 超过正文末尾时给模型的结果（与 Rust `texts::past_end` 同义）。 */
export function pastEndMessage(offset: number, total: number): string {
  return `Nothing left to read from offset ${offset}: this page's text is ${total} characters long.`;
}

/** 从 `offset` 起读时，告诉模型这段正文在整页中的位置。 */
export function offsetLead(offset: number, total: number): string {
  return `The content below is one part of a longer page: it starts ${offset} characters into the page's ${total}.`;
}

/** 取前 `max` 个 Unicode 标量；返回值里的 `count` 是实际取到的字符数。 */
function takeCharacters(text: string, max: number): { text: string; count: number } {
  let index = 0;
  let count = 0;
  while (index < text.length && count < max) {
    const code = text.codePointAt(index) ?? 0;
    index += code > 0xffff ? 2 : 1;
    count += 1;
  }
  return { text: text.slice(0, index), count };
}

/**
 * 把交给处理模型的正文裁到 `MAX_MODEL_INPUT_CHARS`。带 `window`（从 offset 起读）时，
 * 说明里给出整页长度与下一次续读的 offset，模型可以一次调用读不完就接着读。
 */
export function truncateContentForModel(
  content: string,
  window?: Pick<WebFetchContentWindow, "offset" | "total">,
): { content: string; truncated: boolean } {
  if (window) {
    if (window.total - window.offset <= MAX_MODEL_INPUT_CHARS) {
      return { content, truncated: false };
    }
    const note = (end: number) =>
      `\n\n[WebFetch note: this page's text is ${window.total} characters long and the answer above covers only characters ${window.offset} to ${end}; the final ${window.total - end} were not read — to read on, call WebFetch again with the same url and offset: ${end}.]`;
    // 先用一个同量级的结尾算预算，再按真实结尾重建说明（数字位数差异最多几个字符）。
    const budget = Math.max(0, MAX_MODEL_INPUT_CHARS - note(window.offset + MAX_MODEL_INPUT_CHARS).length);
    const taken = takeCharacters(content, budget);
    return { content: `${taken.text}${note(window.offset + taken.count)}`, truncated: true };
  }
  if (content.length <= MAX_MODEL_INPUT_CHARS) {
    return { content, truncated: false };
  }

  const suffix = "\n\n[WebFetch content truncated before prompt processing]";
  const maxBodyChars = Math.max(0, MAX_MODEL_INPUT_CHARS - suffix.length);
  return {
    content: `${content.slice(0, maxBodyChars)}${suffix}`,
    truncated: true,
  };
}

function htmlToMarkdown(html: string): string {
  let content = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "");

  content = content
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<h4\b[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
    .replace(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi, "\n##### $1\n")
    .replace(/<h6\b[^>]*>([\s\S]*?)<\/h6>/gi, "\n###### $1\n")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|header|footer|tr|table|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  return decodeHtmlEntities(content)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, index, lines) => line.length > 0 || lines[index - 1]?.length !== 0)
    .join("\n")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_match, decimal: string) =>
      String.fromCodePoint(Number.parseInt(decimal, 10)),
    );
}

function isTextLikeMime(mime: string): boolean {
  if (mime.length === 0) return true;
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/xhtml+xml" ||
    mime === "application/javascript" ||
    mime === "application/x-javascript" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}
