# 手机远控：走浏览器，不做原生壳（2026-11-07 决定）

手机远控的完整界面就是 Web 远控页：桌面端二维码里是 `<origin>/remote/v4?...`
（`packages/shared/src/zcodeEndpoint.ts`）。手机相机或浏览器扫码后直接用浏览器打开即可，
**不需要安装任何 App**。

## 已删除：`packages/android`

它曾是一个 Android WebView 壳（Compose + CameraX/ML Kit 扫码 + 前台服务保活 + 最近 5 条链接），
由 2026-10-27 的初始导入带进本仓，不在上游快照里（`scripts/architecture/upstream-snapshot.json`
零命中），也不是上游产品的一部分。

删除理由，逐条可查：

1. **功能重复**：它只承载同一个 `/remote` 页面；浏览器已经能做，额外能力只有「App 内扫码 /
   后台保活 / 最近链接」。
2. **按现状打不开我们自己的链接**：`RemoteControlUrlPolicy` 的生产白名单写死上游
   `https://zcode.z.ai/remote…`，而二维码指向我们自己的 origin —— 正式包会把自家链接判成非法。
3. **深链无人发**：`nibi://remote` 在 desktop / services / shared / web 里零个生产者。
4. **不在任何构建链**：不在 `pnpm-workspace.yaml`，CI 与打包脚本零引用；发行身份还是占位的
   `com.example.zcode_mobile`（示例命名空间，不能当发行身份）。没有任何流水线会产出它。

## 以后真要做原生壳的前提

不要在这份被删的代码上改，重开一份。至少要先定：

- 正式 `applicationId`（与站点同域的反写命名）；
- `nibi://remote` scheme，且产品里真有地方生成这种链接；
- 生产白名单指向我们自己的 origin（是否再加 https App Link 与 `assetlinks.json` 另议）；
- 一条能出 APK 的 Gradle 构建与签名链。

在此之前，远控入口只保留浏览器。
