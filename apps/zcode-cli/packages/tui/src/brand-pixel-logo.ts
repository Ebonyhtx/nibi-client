// Generated from the NIBI brand assets; do not edit by hand.
// 每行是若干色段；半格字符 ▀▄█ 让像素在终端里近似正方。
// *_BLINK 把眼睛换成面部暖白，用于眨眼动画。

export interface NibiLogoRun {
  readonly text: string;
  readonly fg: string | null;
  readonly bg: string | null;
}

export type NibiLogoRow = readonly NibiLogoRun[];

/** NIBI_BIRD_DARK（26 列） */
export const NIBI_BIRD_DARK: readonly NibiLogoRow[] = [
  [{ text: '            ', fg: null, bg: null }, { text: '▄▄██████▄', fg: "#4a79b8", bg: null }, { text: '     ', fg: null, bg: null }],
  [{ text: '          ', fg: null, bg: null }, { text: '▄██████████', fg: "#4a79b8", bg: null }, { text: '▀', fg: "#4a79b8", bg: "#f5e7d3" }, { text: '▄', fg: "#4a79b8", bg: null }, { text: '   ', fg: null, bg: null }],
  [{ text: '         ', fg: null, bg: null }, { text: '██████', fg: "#4a79b8", bg: null }, { text: '▀', fg: "#4a79b8", bg: "#f5e7d3" }, { text: '██', fg: "#f5e7d3", bg: null }, { text: '▀', fg: "#4a79b8", bg: "#0a121e" }, { text: '▀', fg: "#f5e7d3", bg: "#4a79b8" }, { text: '█', fg: "#f5e7d3", bg: null }, { text: '▀', fg: "#f5e7d3", bg: "#4a79b8" }, { text: '▀', fg: "#4a79b8", bg: "#e89645" }, { text: '▀▀', fg: "#4a79b8", bg: null }, { text: ' ', fg: null, bg: null }],
  [{ text: '       ', fg: null, bg: null }, { text: '▄█████', fg: "#4a79b8", bg: null }, { text: '▀', fg: "#4a79b8", bg: "#f5e7d3" }, { text: '████', fg: "#f5e7d3", bg: null }, { text: '▀', fg: "#e89645", bg: "#f5e7d3" }, { text: '██', fg: "#f5e7d3", bg: null }, { text: '     ', fg: null, bg: null }],
  [{ text: '     ', fg: null, bg: null }, { text: '▄████████', fg: "#4a79b8", bg: null }, { text: '▀', fg: "#f5e7d3", bg: "#e89645" }, { text: '█████', fg: "#f5e7d3", bg: null }, { text: '▀', fg: "#f5e7d3", bg: "#e89645" }, { text: '     ', fg: null, bg: null }],
  [{ text: '    ', fg: null, bg: null }, { text: '████████', fg: "#4a79b8", bg: null }, { text: '▀', fg: "#4a79b8", bg: "#e89645" }, { text: '████████', fg: "#e89645", bg: null }, { text: '     ', fg: null, bg: null }],
  [{ text: ' ', fg: null, bg: null }, { text: '▄▄██████', fg: "#4a79b8", bg: null }, { text: '▀▀', fg: "#4a79b8", bg: "#e89645" }, { text: '█████████▀', fg: "#e89645", bg: null }, { text: '     ', fg: null, bg: null }],
  [{ text: '▀▀▀▀▀', fg: "#4a79b8", bg: null }, { text: '▀', fg: "#4a79b8", bg: "#e89645" }, { text: '█████████████', fg: "#e89645", bg: null }, { text: '       ', fg: null, bg: null }],
  [{ text: '      ', fg: null, bg: null }, { text: '▀█████████▀▀', fg: "#e89645", bg: null }, { text: '        ', fg: null, bg: null }],
  [{ text: '        ', fg: null, bg: null }, { text: '▀▀▀▀▀▀', fg: "#e89645", bg: null }, { text: '            ', fg: null, bg: null }],
];

/** NIBI_BIRD_DARK_BLINK（26 列） */
export const NIBI_BIRD_DARK_BLINK: readonly NibiLogoRow[] = [
  [{ text: '              ', fg: null, bg: null }, { text: '▄▄▄▄▄▄', fg: "#4a79b8", bg: null }, { text: '      ', fg: null, bg: null }],
  [{ text: '           ', fg: null, bg: null }, { text: '▄█████████▄', fg: "#4a79b8", bg: null }, { text: '    ', fg: null, bg: null }],
  [{ text: '         ', fg: null, bg: null }, { text: '▄██████', fg: "#4a79b8", bg: null }, { text: '▀▀', fg: "#4a79b8", bg: "#f5e7d3" }, { text: '█', fg: "#4a79b8", bg: null }, { text: '▀▀', fg: "#4a79b8", bg: "#f5e7d3" }, { text: '█', fg: "#f5e7d3", bg: null }, { text: '█▄▄', fg: "#4a79b8", bg: null }, { text: ' ', fg: null, bg: null }],
  [{ text: '        ', fg: null, bg: null }, { text: '▄█████', fg: "#4a79b8", bg: null }, { text: '▀', fg: "#4a79b8", bg: "#f5e7d3" }, { text: '███', fg: "#f5e7d3", bg: null }, { text: '▀', fg: "#f5e7d3", bg: "#e89645" }, { text: '▀', fg: "#4a79b8", bg: "#f5e7d3" }, { text: '█', fg: "#f5e7d3", bg: null }, { text: '▀', fg: "#4a79b8", bg: null }, { text: '▀', fg: "#e89645", bg: null }, { text: '   ', fg: null, bg: null }],
  [{ text: '      ', fg: null, bg: null }, { text: '▄██████', fg: "#4a79b8", bg: null }, { text: '▀', fg: "#f5e7d3", bg: "#4a79b8" }, { text: '███████', fg: "#f5e7d3", bg: null }, { text: '     ', fg: null, bg: null }],
  [{ text: '    ', fg: null, bg: null }, { text: '▄████████', fg: "#4a79b8", bg: null }, { text: '▀', fg: "#4a79b8", bg: "#e89645" }, { text: '█', fg: "#e89645", bg: null }, { text: '▀▀▀▀▀', fg: "#f5e7d3", bg: "#e89645" }, { text: '█', fg: "#e89645", bg: null }, { text: '     ', fg: null, bg: null }],
  [{ text: '   ', fg: null, bg: null }, { text: '▄███████', fg: "#4a79b8", bg: null }, { text: '▀', fg: "#4a79b8", bg: "#e89645" }, { text: '█████████', fg: "#e89645", bg: null }, { text: '     ', fg: null, bg: null }],
  [{ text: '▄█████', fg: "#4a79b8", bg: null }, { text: '▀▀▀', fg: "#4a79b8", bg: "#e89645" }, { text: '██████████▀', fg: "#e89645", bg: null }, { text: '      ', fg: null, bg: null }],
  [{ text: '     ', fg: null, bg: null }, { text: '▀████████████▀', fg: "#e89645", bg: null }, { text: '       ', fg: null, bg: null }],
  [{ text: '       ', fg: null, bg: null }, { text: '▀▀▀▀▀▀▀▀▀', fg: "#e89645", bg: null }, { text: '          ', fg: null, bg: null }],
];

/** NIBI_BIRD_LIGHT（26 列） */
export const NIBI_BIRD_LIGHT: readonly NibiLogoRow[] = [
  [{ text: '            ', fg: null, bg: null }, { text: '▄▄██████▄', fg: "#142d52", bg: null }, { text: '     ', fg: null, bg: null }],
  [{ text: '          ', fg: null, bg: null }, { text: '▄██████', fg: "#142d52", bg: null }, { text: '▀▀', fg: "#142d52", bg: "#e08a3e" }, { text: '█', fg: "#142d52", bg: null }, { text: '▀', fg: "#142d52", bg: "#e08a3e" }, { text: '▀', fg: "#142d52", bg: "#fdf6ea" }, { text: '▄', fg: "#e08a3e", bg: null }, { text: '   ', fg: null, bg: null }],
  [{ text: '         ', fg: null, bg: null }, { text: '█████', fg: "#142d52", bg: null }, { text: '▀', fg: "#142d52", bg: "#e08a3e" }, { text: '▀', fg: "#e08a3e", bg: "#fdf6ea" }, { text: '██', fg: "#fdf6ea", bg: null }, { text: '▀', fg: "#e08a3e", bg: "#17233b" }, { text: '▀', fg: "#e08a3e", bg: "#142d52" }, { text: '█', fg: "#fdf6ea", bg: null }, { text: '▀', fg: "#fdf6ea", bg: "#e08a3e" }, { text: '▀', fg: "#142d52", bg: "#e08a3e" }, { text: '▀', fg: "#142d52", bg: null }, { text: '▀', fg: "#e08a3e", bg: null }, { text: ' ', fg: null, bg: null }],
  [{ text: '       ', fg: null, bg: null }, { text: '▄█████', fg: "#142d52", bg: null }, { text: '▀', fg: "#e08a3e", bg: "#fdf6ea" }, { text: '████', fg: "#fdf6ea", bg: null }, { text: '▀', fg: "#e08a3e", bg: "#fdf6ea" }, { text: '██', fg: "#fdf6ea", bg: null }, { text: '     ', fg: null, bg: null }],
  [{ text: '     ', fg: null, bg: null }, { text: '▄███████', fg: "#142d52", bg: null }, { text: '▀', fg: "#e08a3e", bg: "#142d52" }, { text: '▀', fg: "#fdf6ea", bg: "#e08a3e" }, { text: '█████', fg: "#fdf6ea", bg: null }, { text: '▀', fg: "#fdf6ea", bg: "#e08a3e" }, { text: '     ', fg: null, bg: null }],
  [{ text: '    ', fg: null, bg: null }, { text: '████████', fg: "#142d52", bg: null }, { text: '▀', fg: "#142d52", bg: "#e08a3e" }, { text: '████████', fg: "#e08a3e", bg: null }, { text: '     ', fg: null, bg: null }],
  [{ text: ' ', fg: null, bg: null }, { text: '▄▄██████', fg: "#142d52", bg: null }, { text: '▀▀', fg: "#142d52", bg: "#e08a3e" }, { text: '█████████▀', fg: "#e08a3e", bg: null }, { text: '     ', fg: null, bg: null }],
  [{ text: '▀▀▀▀▀', fg: "#142d52", bg: null }, { text: '██████████████', fg: "#e08a3e", bg: null }, { text: '       ', fg: null, bg: null }],
  [{ text: '      ', fg: null, bg: null }, { text: '▀█████████▀▀', fg: "#e08a3e", bg: null }, { text: '        ', fg: null, bg: null }],
  [{ text: '        ', fg: null, bg: null }, { text: '▀▀▀▀▀▀', fg: "#e08a3e", bg: null }, { text: '            ', fg: null, bg: null }],
];

/** NIBI_BIRD_LIGHT_BLINK（26 列） */
export const NIBI_BIRD_LIGHT_BLINK: readonly NibiLogoRow[] = [
  [{ text: '              ', fg: null, bg: null }, { text: '▄▄▄▄▄▄', fg: "#142d52", bg: null }, { text: '      ', fg: null, bg: null }],
  [{ text: '           ', fg: null, bg: null }, { text: '▄█████████▄', fg: "#142d52", bg: null }, { text: '    ', fg: null, bg: null }],
  [{ text: '         ', fg: null, bg: null }, { text: '▄█████', fg: "#142d52", bg: null }, { text: '▀', fg: "#142d52", bg: "#e08a3e" }, { text: '▀', fg: "#142d52", bg: "#fdf6ea" }, { text: '▀', fg: "#e08a3e", bg: "#fdf6ea" }, { text: '█', fg: "#e08a3e", bg: null }, { text: '▀', fg: "#142d52", bg: "#e08a3e" }, { text: '▀', fg: "#e08a3e", bg: "#fdf6ea" }, { text: '█', fg: "#fdf6ea", bg: null }, { text: '▀', fg: "#e08a3e", bg: "#142d52" }, { text: '▄', fg: "#142d52", bg: null }, { text: '▄', fg: "#e08a3e", bg: null }, { text: ' ', fg: null, bg: null }],
  [{ text: '        ', fg: null, bg: null }, { text: '▄████', fg: "#142d52", bg: null }, { text: '▀', fg: "#142d52", bg: "#e08a3e" }, { text: '▀', fg: "#e08a3e", bg: "#fdf6ea" }, { text: '███', fg: "#fdf6ea", bg: null }, { text: '▀', fg: "#fdf6ea", bg: "#e08a3e" }, { text: '▀', fg: "#142d52", bg: "#fdf6ea" }, { text: '█', fg: "#fdf6ea", bg: null }, { text: '▀▀', fg: "#e08a3e", bg: null }, { text: '   ', fg: null, bg: null }],
  [{ text: '      ', fg: null, bg: null }, { text: '▄██████', fg: "#142d52", bg: null }, { text: '▀', fg: "#fdf6ea", bg: "#e08a3e" }, { text: '███████', fg: "#fdf6ea", bg: null }, { text: '     ', fg: null, bg: null }],
  [{ text: '    ', fg: null, bg: null }, { text: '▄████████', fg: "#142d52", bg: null }, { text: '▀', fg: "#142d52", bg: "#e08a3e" }, { text: '█', fg: "#e08a3e", bg: null }, { text: '▀▀▀▀▀', fg: "#fdf6ea", bg: "#e08a3e" }, { text: '█', fg: "#e08a3e", bg: null }, { text: '     ', fg: null, bg: null }],
  [{ text: '   ', fg: null, bg: null }, { text: '▄███████', fg: "#142d52", bg: null }, { text: '▀', fg: "#142d52", bg: "#e08a3e" }, { text: '█████████', fg: "#e08a3e", bg: null }, { text: '     ', fg: null, bg: null }],
  [{ text: '▄████', fg: "#142d52", bg: null }, { text: '▀▀▀▀', fg: "#142d52", bg: "#e08a3e" }, { text: '██████████▀', fg: "#e08a3e", bg: null }, { text: '      ', fg: null, bg: null }],
  [{ text: '     ', fg: null, bg: null }, { text: '▀████████████▀', fg: "#e08a3e", bg: null }, { text: '       ', fg: null, bg: null }],
  [{ text: '       ', fg: null, bg: null }, { text: '▀▀▀▀▀▀▀▀▀', fg: "#e08a3e", bg: null }, { text: '          ', fg: null, bg: null }],
];
