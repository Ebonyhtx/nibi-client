import React, { useEffect, useState } from "react";
import { RGBA, StyledText, type TextChunk } from "@mbears/opentui-core";
import { useTerminalDimensions } from "@mbears/opentui-react";
import { palette } from "./app-model.js";
import {
  NIBI_BIRD_DARK,
  NIBI_BIRD_DARK_BLINK,
  NIBI_BIRD_LIGHT,
  NIBI_BIRD_LIGHT_BLINK,
  type NibiLogoRow,
} from "./brand-pixel-logo.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

/**
 * 空状态 logo 的纯文本投影（每行把色段的 text 拼起来）：给渲染断言与需要
 * 「logo 长什么样」的外部消费者用。像素数据只有一份，见 brand-pixel-logo.ts。
 */
export const NIBI_LOGO_LINES: readonly string[] = NIBI_BIRD_DARK.map((row) =>
  row.map((run) => run.text).join(""),
);

/** 眨眼节奏：每 BLINK_PERIOD_MS 眨一次，持续 BLINK_HOLD_MS。 */
const BLINK_PERIOD_MS = 4200;
const BLINK_HOLD_MS = 260;
const BLINK_TICK_MS = 130;

/** 终端太矮时干脆不画 logo，避免把会话区挤没。 */
const MIN_TERMINAL_HEIGHT_MARGIN = 8;

const rgbaCache = new Map<string, RGBA>();

function rgba(color: string): RGBA {
  const cached = rgbaCache.get(color);
  if (cached) return cached;
  const parsed = RGBA.fromHex(color);
  rgbaCache.set(color, parsed);
  return parsed;
}

/** 背景偏暗时用深色变体（海军蓝提亮为钢蓝），否则用品牌原值。 */
function isDarkBackground(color: string): boolean {
  const hex = color.trim().replace(/^#/, "");
  if (hex.length !== 6) return true;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
}

function rowToStyledText(row: NibiLogoRow): StyledText {
  const chunks: TextChunk[] = [];
  for (const run of row) {
    if (run.fg === null && run.bg === null) {
      chunks.push({ __isChunk: true, attributes: 0, text: run.text });
      continue;
    }
    chunks.push({
      __isChunk: true,
      attributes: 0,
      ...(run.fg === null ? {} : { fg: rgba(run.fg) }),
      ...(run.bg === null ? {} : { bg: rgba(run.bg) }),
      text: run.text,
    });
  }
  return new StyledText(chunks);
}

/** 周期性返回 true 一小段时间，用作眨眼帧。 */
function useBlinking(animated: boolean): boolean {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!animated) return undefined;
    const timer = setInterval(() => setNow(Date.now()), BLINK_TICK_MS);
    return () => clearInterval(timer);
  }, [animated]);
  if (!animated) return false;
  return now % BLINK_PERIOD_MS < BLINK_HOLD_MS;
}

/**
 * 空会话与启动屏的品牌位：NIBI 品牌角色（红胸䴓）的终端像素画。
 *
 * 半格字符让像素在终端里近似正方，颜色取自品牌调色板；过矮的终端直接不画，
 * 避免挤压会话区。像素数据由 `tools/make-nibi-logo.py` 从品牌素材生成，
 * 说明见 `brand-pixel-logo.ts` 头部。
 */
export function EmptyTranscriptLogo({
  animated = false,
}: {
  animated?: boolean;
} = {}): React.ReactElement {
  return h(RenderLogo, { animated });
}

function RenderLogo({ animated }: { animated: boolean }): React.ReactElement {
  const { height } = useTerminalDimensions();
  const blinking = useBlinking(animated);

  const rows = blinking
    ? isDarkBackground(palette.background)
      ? NIBI_BIRD_DARK_BLINK
      : NIBI_BIRD_LIGHT_BLINK
    : isDarkBackground(palette.background)
      ? NIBI_BIRD_DARK
      : NIBI_BIRD_LIGHT;

  if (height < rows.length + MIN_TERMINAL_HEIGHT_MARGIN) {
    return h("box", { style: { flexGrow: 1, width: "100%" } });
  }

  return h(
    "box",
    {
      style: {
        alignItems: "center",
        flexDirection: "column",
        flexGrow: 1,
        justifyContent: "center",
        minHeight: rows.length,
        width: "100%",
      },
    },
    ...rows.map((row, index) =>
      h("text", {
        content: rowToStyledText(row),
        key: `nibi-logo-${index}`,
      }),
    ),
  );
}
