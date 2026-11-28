# 宣纸书案（Folio Desk）主题与排版

2026-11 的桌面 UI 改版把「纸上的鸟」的暖纸面语言推进为四套纸墨主题，引入三族随包分发的可变字体，并把桌面顶栏内联进工作区头部。token 数值只以 [`packages/ui/src/styles.css`](../../packages/ui/src/styles.css) 为准，本文只描述结构与使用规则，不复制数值。

## 主题

| 偏好值          | 设置页名称 | 气质                         | 强调色角色 |
| --------------- | ---------- | ---------------------------- | ---------- |
| `nibi-light`    | 宣纸浅     | 暖纸面 + 海军蓝墨 + 陶土橙   | 陶土橙     |
| `nibi-mist`     | 石膏灰     | 冷雾纸面 + 墨青字 + 石青     | 石青       |
| `nibi-dark`     | 暖墨暗     | 中性炭黑 + 奶油金            | 奶油金     |
| `nibi-obsidian` | 冷曜石     | 曜石蓝黑 + 冷白字 + 海沫青   | 海沫青     |

- 默认 `nibi-light`。`system` 只解析为明/暗两档，再落到 `nibi-light` / `nibi-dark`；`light` / `dark` 旧值继续可用并归一为对应 NIBI 主题。
- 根节点同时带解析后的 `dark` 类与具体的 `theme-nibi-*` 类。只写 `dark:` 变体、漏掉主题类会落到默认 token，是掉色类 bug 的常见成因。
- 选中色、阴影、纸面光晕、代码高亮底色都由每套主题的 `--nibi-*` / `--color-*` token 提供；新组件不要写死主题色。
- 主题切换走 View Transition；`prefers-reduced-motion` 或偏好 `motion=off` 时直接切换。
- 设置页主题卡与快捷菜单共用 `THEME_SWATCH_META` 的装饰性色板（圆点/缩略图用），它不是 token 真源；真实取值仍看 `styles.css`。

## 字体

| Token            | 字族                                                        | 用途                                       |
| ---------------- | ----------------------------------------------------------- | ------------------------------------------ |
| `--font-sans`    | Inter Variable + 各平台 CJK 无衬线                          | 全部界面正文与控件                         |
| `--font-display` | Newsreader Variable + Noto Serif SC Variable + 平台衬线兜底 | 品牌、登录标题、主题画廊标题等少量展示文字 |
| `--font-mono`    | JetBrains Mono Variable + 平台等宽 + CJK 无衬线兜底         | 路径、命令、哈希、模型 ID、代码与终端      |

- 字号体系不变：界面文字仍只用 `text-ui-*`；`font-display` 只决定字形，不改变字号。
- 字体由 `@fontsource-variable/*` 随包分发，不依赖系统安装或网络；Windows 的等宽栈显式补 CJK 兜底，避免中文落到宋体。

## 顶栏

- 桌面工作区（`useFolioTopBar`）把导航与窗口控制内联进 `WorkspaceHeader`，不再以浮层压在内容上；Windows/Linux 的窗口按钮由 `DesktopWindowControls` 渲染在头部右侧。
- 手机远控壳保留原浮动顶栏；顶部拖拽区与 `no-drag` 规则不变。

## 工作指示器

- `NibiWorkingIndicator`（`packages/ui/src/components/mobile-ui/`）用五瓣羽阵与暖晕表达 Agent 工作状态，`phase` 为 `starting` / `thinking` / `tooling` / `generating`。
- 桌面消息流、手机远控连接页与 OAuth 回调共用同一组件；标签文案走 i18n `chat.workingPhase.*`，组件本身不依赖 store。

## 设置页与快捷菜单

- 外观页是五张主题卡（含跟随系统）的单选画廊；侧栏主题菜单与快捷菜单复用同一份色板元数据。
- 设置侧栏分组为：常规与外观 / 模型与智能体 / 扩展与自动化 / 环境与设备 / 数据与归档。常规页内按「语言与工作模式、通知与桌面运行、对话工具展示、终端环境、网络与代理、存储更新与引导」分卡片。
- 快捷菜单提供四个主题直达与设置分区跳转。

## 验证

- `packages/ui/test/appearanceThemeGallery.test.ts` 覆盖五卡画廊与选中态；主题归一化与浏览器主题面同步见 `packages/ui/test/useTheme.test.ts`。
- 视觉改动必须在真实客户端逐主题截图验收；单测不能代替真机观感。
