import type { BrowserViewportSize } from "@nibi/shared";

/** 人类浏览器的常用设备快捷尺寸；只改宽高，不改缩放档位。 */
export const BROWSER_VIEWPORT_DEVICE_PRESETS = [
  { id: "phone", width: 390, height: 844 },
  { id: "tablet", width: 834, height: 1112 },
  { id: "desktop", width: 1440, height: 900 },
  { id: "slide", width: 1920, height: 1080 },
] as const satisfies ReadonlyArray<BrowserViewportSize & { id: string }>;

export type BrowserViewportDevicePresetId =
  (typeof BROWSER_VIEWPORT_DEVICE_PRESETS)[number]["id"];
export type BrowserViewportPresetSelection = BrowserViewportDevicePresetId | "custom";

export function resolveBrowserViewportDevicePresetId(
  viewportSize: BrowserViewportSize,
): BrowserViewportPresetSelection {
  const match = BROWSER_VIEWPORT_DEVICE_PRESETS.find(
    (preset) => preset.width === viewportSize.width && preset.height === viewportSize.height,
  );
  return match?.id ?? "custom";
}