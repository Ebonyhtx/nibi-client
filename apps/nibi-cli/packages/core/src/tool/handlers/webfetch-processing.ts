import {
  CoreErrorType,
  createCoreError,
  runWithModelInvocationContext,
  type ModelInputMessage,
  type WebFetchInput,
} from "@nibi/contracts";
import type { ToolExecutionContext } from "../types.js";
import { auxiliaryModelOptions } from "../../model/auxiliary-model-options.js";
import { MAX_MODEL_INPUT_CHARS, WEBFETCH_TOOL_NAME } from "./webfetch-constants.js";
import {
  offsetLead,
  pastEndMessage,
  sliceContentFromOffset,
  truncateContentForModel,
} from "./webfetch-content.js";
import { webFetchError } from "./webfetch-errors.js";
import { traceFromContext } from "./webfetch-trace.js";
import type { CachedFetchContent } from "./webfetch-types.js";

interface WebFetchProcessingOptions {
  preapprovedUrl?: boolean;
}

export async function processFetchedContent(
  input: WebFetchInput,
  fetched: CachedFetchContent,
  context: ToolExecutionContext,
  options: WebFetchProcessingOptions = {},
): Promise<{ result: string; truncated: boolean }> {
  // 续读：只把 offset 之后的正文交给处理模型；越过末尾时明确告诉模型没有更多了。
  const window = sliceContentFromOffset(fetched.content, input.offset ?? 0);
  if (window.pastEnd) {
    return { result: pastEndMessage(window.offset, window.total), truncated: false };
  }
  if (shouldReturnMarkdownDirectly(fetched, options) && window.content.length < MAX_MODEL_INPUT_CHARS) {
    return { result: window.content, truncated: false };
  }

  const model = context.model;
  if (!model) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Model is not configured for WebFetch prompt processing",
      {
        context: {
          toolCallId: context.toolCallId,
          toolName: WEBFETCH_TOOL_NAME,
        },
        recoverable: false,
      },
    );
  }

  const { content, truncated } = truncateContentForModel(
    window.content,
    window.offset > 0 ? window : undefined,
  );
  const lead = window.offset > 0 ? offsetLead(window.offset, window.total) : undefined;
  const messages: ModelInputMessage[] = [
    {
      role: "user",
      content: buildProcessingPrompt(content, input.prompt, options.preapprovedUrl === true, lead),
    },
  ];

  try {
    const result = await runWithModelInvocationContext(
      {
        metadata: {
          querySource: "web_fetch_processing",
          traceId: context.traceId,
          toolCallId: context.toolCallId,
          toolName: WEBFETCH_TOOL_NAME,
        },
        modelCall: { operation: "web_fetch_processing" },
        traceContext: traceFromContext(context),
      },
      () =>
        model.generateText({
          messages,
          tools: [],
          options: {
            ...auxiliaryModelOptions(model),
            maxOutputTokens: Math.min(4096, model.optionSpecs.maxOutputTokens.max),
          },
          abortSignal: context.abortSignal,
        }),
    );

    return {
      result:
        result.text.trim() || "WebFetch completed, but the extraction model returned no text.",
      truncated,
    };
  } catch (error) {
    throw webFetchError(
      "ProcessingFailed",
      error instanceof Error ? error.message : "WebFetch prompt processing failed",
      {
        url: fetched.finalUrl,
      },
      error,
    );
  }
}

function shouldReturnMarkdownDirectly(
  fetched: CachedFetchContent,
  options: WebFetchProcessingOptions,
): boolean {
  return (
    options.preapprovedUrl === true &&
    fetched.contentType.toLowerCase().includes("text/markdown")
  );
}

function buildProcessingPrompt(
  content: string,
  prompt: string,
  preapprovedUrl: boolean,
  lead?: string,
): string {
  const instruction = preapprovedUrl
    ? "Provide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed."
    : [
        "Provide a concise response based only on the content above. In your response:",
        " - Enforce a strict 125-character maximum for quotes from any source document. Open Source Software is ok as long as we respect the license.",
        " - Use quotation marks for exact language from articles; any language outside of the quotation should never be word-for-word the same.",
        " - You are not a lawyer and never comment on the legality of your own prompts and responses.",
        " - Never produce or reproduce exact song lyrics.",
      ].join("\n");

  return `
${lead === undefined ? "" : `${lead}\n`}Web page content:
---
${content}
---

${prompt}

${instruction}
`;
}
