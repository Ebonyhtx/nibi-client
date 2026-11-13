# NIBI 服务端架构迁移后，客户端要跟着改的事

状态：**服务端已完成，客户端待发版**（2026-11-12 更新）。

- **服务端已收口**：德国退役抹盘，`nibistudio.top` / EdgeOne / Cloudflare 全退；`nibistudio.cn` 承载完整业务；
  内容走 OSS（`dl.` 分发 + 付费件预签名）。现状见 `.artifacts/server-bootstrap/RUNBOOK-aliyun-access.md` §0。
- **客户端已做**：全仓 `.top` → `.cn`（`0e053b77`，82 文件 / 229 处），覆盖 §1 全部端点常量、
  `nibiContentHosts` 主内容 host 白名单、`plugin-marketplaces` 清单 URL、Rust 内核 `origins.rs`；
  `pnpm typecheck` 与单测全绿。
- **仍未做**（发版前必须过）：① Rust 内核是**编译期常量，不重建不生效**；
  ② §2 的构建期 CDN/OSS 变量与发布脚本要逐项核对（涉及路径与多账号映射，不是纯域名替换）；
  ③ 已发布的 npm 包 / 桌面安装包仍是旧构建；④ 插件 zip 内 `env_setup` 仍指向 `.top`。

原则：客户端只认 NIBI 自有端点或空；任何上游域名都不回落（分家标准见 `docs/adr/` 与 `AGENTS.md` 的遥测/端点约束；运维口径见 `NIBI-Site/deploy/RUNBOOK.md` §0）。

## 1. API、账号与会员

- [ ] `packages/shared/src/zcodeEndpoint.ts`：`DEFAULT_NIBI_ENDPOINT_ORIGIN`、`TEST_NIBI_ENDPOINT_ORIGIN`、`DEFAULT_NIBI_WEB_ORIGIN`、`NIBI_WEB_ORIGIN_ALIASES`、`DEFAULT_WEB_REMOTE_CONTROL_RELAY_WS_URL`。
- [ ] `packages/shared/src/nibiAuth.ts` / `oauth.ts`：`NIBI_AUTH_ORIGIN`（auth.*）与 OIDC 回调白名单。
- [ ] `packages/services/src/oauth/providers/nibiProviderConfig.ts`：`NIBI_API_BASE_URL`、`NIBI_MEMBERSHIP_SITE_URL`。
- [ ] `packages/services/src/license/*`：license check / refresh 的 origin（`api.*/api/v1/licenses/*`）。
- [ ] `packages/services/src/feedback/feedbackHttpClient.ts`：反馈工单端点。
- [ ] `packages/shared/src/api.ts`：Host/Provider 端点替换逻辑与测试域。

## 2. CDN 与下载

- [ ] 构建期 `CDN_DOMAIN` + `OSS_PATH_PREFIX`（`packages/desktop/tsup.config.ts`、CI/发布脚本）改指向新 CDN；**不再保留任何旧域名**。
- [ ] `packages/desktop/src/main/remoteCdn.ts`：远端 Source Server release 根（只认构建期注入/`NIBI_REMOTE_ASSET_CDN_BASE_URL`）。
- [ ] `packages/desktop/src/host/sourceServerReleaseResolver.ts`：release descriptor / archive 的下载、校验（SHA/size）、`local-download-upload` 与 `remote-download` 两种模式在新 CDN 上可用。
- [ ] `packages/shared/src/nibiContentHosts.ts` 与 `packages/shared/src/node/nibiContentSignature.ts`：主内容 host 白名单（现为 `api.nibistudio.cn`、`dl.nibistudio.cn`）与 `.sig` 校验域名。
- [ ] `packages/shared/src/plugin-marketplaces.ts`：官方插件市场清单 URL。
- [ ] `packages/desktop/src/main/manifestUpdateProvider.ts`：Electron 更新 manifest 路径 `/api/v1/releases/electron/manifest` 及下载源。
- [ ] `scripts/cdn-preload.sh`、`scripts/build-desktop-agent-cli.mjs` 等发布脚本里的 CDN/OSS 变量与多账号映射。

## 3. 中转、手机远控与站点

- [ ] `DEFAULT_WEB_REMOTE_CONTROL_RELAY_WS_URL`（`wss://.../api/v1/remote/ws2`）与 Relay V2 的 JWT/一次性 token 契约。
- [ ] 手机远控 Web 登录：Zitadel SPA origin、回调地址、令牌代理；`packages/web` 的 `VITE_NIBI_BASE_URL`。
- [ ] `packages/web/src/share/ConversationShareLandingPage.tsx` 的下载链接与站点 origin。
- [ ] `packages/desktop/src/main/desktopArchitectureGuard.ts` 的下载/架构页 URL。
- [ ] 桌面 CSP：`form-action`、`connect-src`、自定义协议 `nibi://` 与新的 auth/web/relay 域。

## 4. 验收

- [ ] `pnpm typecheck`
- [ ] `pnpm test:unit`（至少 `packages/shared/test/zcodeEndpoint*`、`nibiContentSignature*`、`packages/desktop/test/connectDesktopSourceServer*`、`remoteWorkspace*`、`desktopRuntimeEnv*`、`webRemoteControlProxy*`）
- [ ] 真机：登录/刷新/退出（device flow + 手机扫码）、会员购买与续费、插件市场安装/更新、Electron 更新检查、远控连接与中转、SSH/WSL/Docker 远程项目“本地下载后上传”和“远程服务器下载”两种模式的连接、文件、终端与任务。
- [ ] 远端 Source Server release 的 `remote-download` 模式必须在**真实新 CDN** 上跑通（服务器能访问 CDN、解压与 SHA 校验），不能只在 mock-cdn 上过。
