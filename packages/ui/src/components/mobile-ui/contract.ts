import type { ComponentProps } from "react";
import type { Dialog } from "radix-ui";

export interface DevicePlatformIconProps {
  platform?: string;
  className?: string;
}
export interface NibiAppLogoProps {
  className?: string;
}
export type BottomSheetProps = ComponentProps<typeof Dialog.Root>;
export type BottomSheetContentProps = ComponentProps<typeof Dialog.Content>;
export type NibiWorkingPhase = "starting" | "thinking" | "tooling" | "generating";
export interface NibiWorkingIndicatorProps {
  label?: string;
  phase?: NibiWorkingPhase;
  compact?: boolean;
  className?: string;
}
