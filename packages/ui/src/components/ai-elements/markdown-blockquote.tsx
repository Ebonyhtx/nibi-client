"use client";

import type { ComponentProps } from "react";
import { cn } from "@/components/lib/utils.js";

export type MarkdownBlockquoteProps = ComponentProps<"blockquote"> & {
  node?: unknown;
};

export function MarkdownBlockquote({ className, node: _node, ...props }: MarkdownBlockquoteProps) {
  return (
    <blockquote
      className={cn(
        "my-4 rounded-r-lg border-l-[3px] border-primary/55 bg-surface/75 px-4 py-2.5 text-foreground/85",
        "[&_p]:my-0 [&_p+p]:mt-2",
        className,
      )}
      data-markdown-blockquote=""
      {...props}
    />
  );
}
