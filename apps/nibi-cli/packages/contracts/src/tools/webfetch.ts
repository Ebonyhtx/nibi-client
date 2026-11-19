// ============================================================
// WebFetch Tool - URL fetch and extraction
// ============================================================

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import { toToolJsonSchema } from "./json-schema.js";

// -----------------------------------------------
// Input Schema
// -----------------------------------------------

export const WebFetchInputSchema = z.object({
  url: z.string().url().describe("The URL to fetch content from"),
  prompt: z.string().describe("The prompt to run on the fetched content"),
  /**
   * 与 Rust 内核 `WebFetch` 的 `offset` 同义：页面正文的字符位置，用于在一次调用读不完时
   * 接着读。默认 0；结果里的续读提示会给出下一次该传的值。
   */
  offset: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional()
    .describe(
      "Character position in the page text to start reading from. Use it to read on through a page too long for one call, with the value the previous result gave.",
    ),
});

export type WebFetchInput = z.infer<typeof WebFetchInputSchema>;

export const WebFetchInputJsonSchema = toToolJsonSchema(WebFetchInputSchema);

// -----------------------------------------------
// Output Types
// -----------------------------------------------

export interface WebFetchRedirect {
  from: string;
  to: string;
  status: number;
}

export interface WebFetchOutput {
  url: string;
  finalUrl: string;
  status: number;
  statusText: string;
  contentType: string;
  bytes: number;
  durationMs: number;
  result: string;
  cacheHit: boolean;
  redirects: WebFetchRedirect[];
  artifactUri?: string;
  artifactPath?: string;
  truncated: boolean;
}

export const WebFetchRedirectSchema = z
  .object({
    from: z.string(),
    to: z.string(),
    status: z.number().int().nonnegative(),
  })
  .strict();

export const WebFetchOutputSchema = z
  .object({
    url: z.string(),
    finalUrl: z.string(),
    status: z.number().int().nonnegative(),
    statusText: z.string(),
    contentType: z.string(),
    bytes: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    result: z.string(),
    cacheHit: z.boolean(),
    redirects: z.array(WebFetchRedirectSchema),
    artifactUri: z.string().optional(),
    artifactPath: z.string().optional(),
    truncated: z.boolean(),
  })
  .strict();

export const WebFetchOutputJsonSchema = toToolJsonSchema(WebFetchOutputSchema);

// -----------------------------------------------
// Tool Call Structure
// -----------------------------------------------

export interface WebFetchToolCall {
  id: ToolCallId;
  name: "WebFetch";
  input: WebFetchInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface WebFetchToolResult {
  toolCallId: ToolCallId;
  output: WebFetchOutput;
  traceId: TraceId;
  durationMs: number;
}

// -----------------------------------------------
// WebFetch Errors
// -----------------------------------------------

export const WebFetchErrorCode = {
  InvalidUrl: "webfetch_invalid_url",
  UnsupportedProtocol: "webfetch_unsupported_protocol",
  CredentialsInUrl: "webfetch_credentials_in_url",
  MissingRedirectLocation: "webfetch_missing_redirect_location",
  UnsafeRedirect: "webfetch_unsafe_redirect",
  EgressBlocked: "webfetch_egress_blocked",
  TooManyRedirects: "webfetch_too_many_redirects",
  ResponseTooLarge: "webfetch_response_too_large",
  FetchFailed: "webfetch_fetch_failed",
  ProcessingFailed: "webfetch_processing_failed",
} as const;

export type WebFetchErrorCode = (typeof WebFetchErrorCode)[keyof typeof WebFetchErrorCode];
