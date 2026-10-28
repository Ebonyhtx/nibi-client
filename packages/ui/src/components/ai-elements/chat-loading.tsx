"use client";

import type { ComponentPropsWithoutRef } from "react";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export interface ChatLoadingProps extends ComponentPropsWithoutRef<"div"> {
  loading: boolean;
  size?: "default" | "sm" | "xs" | "avatar";
  className?: string;
}

export function ChatLoading({ loading, size = "default", className, ...props }: ChatLoadingProps) {
  const { intl } = useZCodeIntl();

  if (!loading) {
    return null;
  }

  return (
    <div
      aria-label={intl.formatMessage({ id: "common.loading" })}
      {...props}
      data-zcode-chat-loading-animate="true"
      data-size={size}
      role="status"
      className={cn("flex items-center", className)}
    >
      {/* 与新建会话页同源的 nibi-loop 108 帧循环；缩放到 40px，不再额外做飞行 sprite。 */}
      <span className="nibi-chat-loading-loop" data-size={size} aria-hidden="true">
        <span className="nibi-new-conversation-loop" />
      </span>
    </div>
  );
}
