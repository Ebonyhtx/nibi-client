/**
 * 无图标插件的确定性回退头像。
 *
 * 商店卡片、列表行、详情页与已安装列表共用同一套算法：色相只由插件 id（没有 id 时
 * 用名称）决定，同一插件在任何界面、任何一次渲染都得到同一种颜色，不会随刷新变化。
 * 色板限定在暖色（cream 主题）范围内，并保持深色文字与浅色底的高对比度。
 */

export interface PluginAvatarTone {
  /** 圆角方块底色（浅暖色）。 */
  background: string;
  /** 首字符前景色（深暖色，保证对比度）。 */
  foreground: string;
}

/** 暖色调色板：陶土 / 琥珀 / 赭石 / 沙色 / 蜜色 / 铁锈等，避免刺眼的纯饱和色。 */
export const PLUGIN_AVATAR_TONES: readonly PluginAvatarTone[] = [
  { background: "#F5E1D1", foreground: "#7A3B1A" },
  { background: "#F6E7C8", foreground: "#7A5410" },
  { background: "#F2DCD6", foreground: "#82352A" },
  { background: "#EDE0C8", foreground: "#66512A" },
  { background: "#F4DBC9", foreground: "#87421F" },
  { background: "#EBDFD2", foreground: "#62412E" },
  { background: "#F7E9CF", foreground: "#775414" },
  { background: "#F0DAD0", foreground: "#7B3826" },
] as const;

/** FNV-1a 32 位；对 code point 迭代，中文/emoji 名称也能稳定落桶。 */
function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** 头像种子：优先完整 id（`name@marketplace`），避免不同市场的同名插件共色。 */
export function pluginAvatarSeed(item: { id?: string; name?: string }): string {
  return (item.id?.trim() || item.name?.trim() || "").toLocaleLowerCase();
}

/** 稳定色相：同一 seed 永远命中同一个暖色。空 seed 也返回固定项而非随机。 */
export function pluginAvatarTone(seed: string): PluginAvatarTone {
  const index = hashSeed(seed) % PLUGIN_AVATAR_TONES.length;
  return PLUGIN_AVATAR_TONES[index] ?? PLUGIN_AVATAR_TONES[0]!;
}

/**
 * 首字符：ASCII 字母/数字大写；遇到中文等非 ASCII 字符直接取该字符。
 * 跳过 `@` / `-` / `_` 之类的前缀符号，避免 `@scope/plugin` 显示成 `@`。
 */
export function pluginAvatarInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  for (const char of trimmed) {
    if (/[A-Za-z0-9]/.test(char)) return char.toUpperCase();
    if ((char.codePointAt(0) ?? 0) > 0x7f) return char;
  }
  return Array.from(trimmed)[0] ?? "?";
}
