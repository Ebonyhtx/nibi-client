# NIBI Design System

Portable design rules for UI work in this repository. The single source of truth
for token **values** is [styles.css](packages/ui/src/styles.css); this document
describes intent and usage. Do not copy numeric color values into other docs.

## Product character

NIBI is a desktop-first, web-compatible development workspace. The interface
should feel calm, dense, and operational rather than decorative.

Design for:

- long sessions and high information density
- readable chat, tool output, and code
- keyboard-driven workflows
- desktop and web parity
- Windows, macOS, and Linux
- internationalization and variable text length
- system, light, and dark themes

Avoid oversized marketing spacing, decorative gradients, and bright full-surface
brand fills.

## Typography

All application UI text uses the dedicated `text-ui-*` scale. Do not introduce
Tailwind's built-in `text-sm` / `text-xs` or arbitrary pixel sizes for interface
copy. Code, diff, and terminal content keep their own numeric font-size settings.

| Token | Formula | Default |
| --- | --- | ---: |
| `text-ui-xl` | `--ui-font-size + 4px` | 18px |
| `text-ui-lg` | `--ui-font-size + 2px` | 16px |
| `text-ui-base` | `--ui-font-size` | 14px |
| `text-ui-caption` | `--ui-font-size - 1px` | 13px |
| `text-ui-sm` | `--ui-font-size - 2px` | 12px |
| `text-ui-xs` | `--ui-font-size - 4px` | 10px |

Rules:

- Body copy, ordinary buttons, and section titles use `text-ui-base`.
- Secondary copy uses `text-ui-sm` with `text-foreground-subtle`.
- Badges, counters, and very weak metadata use `text-ui-xs`.
- Markdown `h1` / `h2` use `text-ui-xl` / `text-ui-lg`; `h3`-`h6` use
  `text-ui-base` and differentiate by weight.
- Interface font scaling changes only `--ui-font-size`; never mutate the root
  `html` font size.
- Use `font-mono` for paths, commands, hashes, model IDs, and terminal-like data.

## Color

Use semantic tokens, never raw one-off colors:

- Page roots: `bg-background text-foreground`
- Cards: `bg-card border-card-border`
- Low-emphasis containers: `bg-surface`
- Overlays: `bg-popover` / `bg-menu` with `border-popover-border`
- Hover and selection: `bg-hover` / `bg-selected`
- Primary action: `bg-primary text-primary-foreground`

Use success, warning, and destructive colors only for real semantic states.
Surface variants (`*-surface`) pair with their matching foreground and must keep
at least 4.5:1 contrast in every shipped theme.

Git status colors use `text-git-*` / `bg-git-*`, not generic diff or warning
tokens. Diff UI uses the diff-specific tokens only.

## Spacing

Base unit: `4px`.

- `4px`: icon/text alignment
- `8px`: compact control padding and inline gaps
- `12px`: dense list rows and menu items
- `16px`: standard card and panel padding
- `20px`–`24px`: larger sections and dialog interiors

Keep operational UI compact. Prefer a small set of repeated gaps over arbitrary
values. Add `min-w-0` where text must truncate and `min-h-0` where a flex child
must scroll.

## Radius

Radius follows visible container nesting, not component importance:

- First rounded container: `rounded-xl`
- Nested: `rounded-lg` → `rounded-md` → `rounded-sm`
- `rounded-sm` is the minimum
- `rounded-full` only for deliberate pills and circles
- Dialogs: `rounded-2xl`
- Menus and popovers: `rounded-lg`; menu items `rounded-md`

Do not introduce arbitrary radius values or bare `rounded`.

## Sizing

- Default icon size: `size-4`
- Common icon sizes: `size-3`, `size-3.5`, `size-4`, `size-5`, `size-6`
- Common control heights: `h-6`, `h-7`, `h-8`, `h-9`
- Regular inputs prefer `h-9`; compact filters may use `h-7` or `h-8`
- Square icon buttons stay square

Prefer fluid widths and `max-w-*`. Fixed widths are acceptable for menus,
dialogs, and stable side panels.

## Components

- Reuse `packages/ui/src/components/ui/` primitives before adding variants.
- Buttons: primary, outline, secondary, ghost, destructive, link. Do not promote
  every action to primary.
- Inputs: `bg-input border-input-border`; focus uses the focused border/background.
- Cards and panels: one clear surface hierarchy; do not mix card styles without a
  structural reason.
- Menus: dense rows, `p-1`, `gap-0.5`, subtle hover, weak separators.
- Toasts: `bg-toast`, compact padding, stronger shadow; one toast per operation.

## Elevation and motion

Layer primarily through background contrast, borders, and radius.

- Base: no shadow
- Surface: border-led separation
- Overlay: `shadow-md`
- Attention: `shadow-lg` only for toasts and rare emphasized panels

Motion should clarify state change. Favor short fades, zooms, and directional
slides. Respect reduced-motion settings.

## Workspace layout

Desktop and wide web layouts use independent conversation, terminal, and side
pane frames with 4px resizable gaps. Resize handles keep a transparent 4px hit
area and show a 2px indicator on hover, focus, or drag. Mobile layouts keep the
single-column and drawer presentation.

## Responsive behavior

- Start with a stable base layout, then add breakpoints.
- Use breakpoints for layout, width, visibility, and density, not for changing
  component meaning.
- Preserve primary actions at every breakpoint.
- Test long translations; do not rely on truncation alone.

## Accessibility

- Keyboard navigation is a first-class path.
- Keep the established focus styling; do not add global `!important` outlines.
- Maintain 4.5:1 contrast in every theme.
- Never communicate status by color alone.
- Prefer visible text labels over icon-only meaning.
- Use semantic status colors with readable text.
