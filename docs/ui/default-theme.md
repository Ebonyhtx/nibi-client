# 默认主题

## 当前策略

- 应用首次启动且本地没有偏好值时，默认主题为 `nibi-light`；偏好键为 `nibi:prefs`。
- 一旦用户主动切换主题，后续仍然优先读取本地保存值，不会被默认值覆盖。

## 实现位置

- Zustand store 默认值：`packages/ui/src/store/index.ts`
- 旧 `useTheme()` hook 兜底值：`packages/ui/src/useTheme.ts`
