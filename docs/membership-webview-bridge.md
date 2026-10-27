# NIBI 会员购买页 WebView 契约（自有官网）

日期：2026-10-22

购买页是**我们自己的官网** `/membership`，不是上游 `zcode.z.ai/coding-plan`。客户端只负责带登录态打开它，并在支付成功后收到一个完成信号；商品、价格、支付、退款与会员态全部以官网/服务端为准。

## 1. 打开链路

```text
用户点击「开通会员」
  -> NibiMembershipDialog
  -> oauthService.createNibiCheckoutUrl()
       POST {NIBI_API_BASE_URL}/api/v1/auth/handoff   (Bearer = NIBI access token)
       -> { code, expiresAt }
  -> https://nibistudio.top/membership/?embedded=app&handoff=<code>
  -> 官网用一次性 code 换 2 小时站点会话（HttpOnly Cookie），并把 code 从地址栏抹掉
```

- 未登录 NIBI 账号时，客户端不打开网页登录，而是提示回客户端登录。
- `handoff` 是单次使用；刷新必须重新换码，不能 reload 旧 URL。
- 官网地址由 `NIBI_MEMBERSHIP_SITE_URL` 下发（默认 `https://nibistudio.top/membership/`）。
- 本地开发站点是 Astro dev：`http://localhost:4321/membership/`（兼容旧的 3000）。

## 2. 页面 → App：购买完成

preload：`packages/desktop/src/preload/membershipWebview.ts`（构建为 `out/preload/membershipWebview.cjs`）。

页面侧可用：

```js
window.nibiBridge?.notifyPurchaseComplete?.({ provider: "nibi" });
```

- 只有**我们自己的官网** `/membership` 及其子路径才会注入 `window.nibiBridge`；同一域名下的 `/portal`、`/admin` 等页面不继承 App 通信能力。
- 上游 `zcode.z.ai`、`api.nibistudio.top` 都**不在**信任列表里。
- 桥只暴露这一个业务函数，不暴露 `ipcRenderer` / Node 原语；payload 的 `provider` 必须是 `"nibi"`，否则丢弃。
- 官网在普通浏览器打开时没有桥，调用静默降级，不影响页面自己的成功态。

IPC：`nibi:membership-purchase-complete`（`NibiMembershipWebviewChannels.PurchaseComplete`）。

宿主收到后：

1. 校验 payload（`provider === "nibi"`）；
2. 刷新 `oauthService.getNibiMembershipStatus()`；
3. 展示「支付成功，会员已生效」并关闭弹窗。

## 3. 安全与隔离

- webview 固定 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。
- 只接受 `http:` / `https:`；preload 在注入前自行再校验 origin + path。
- 独立持久 partition：`persist:nibi-membership`（`NibiMembershipDialog` 的 `<webview partition>`）。
  - 退出登录 / Clear All Data 时显式 `clearStorageData()`，避免旧账号站点 Cookie 被下一次打开读到。
  - 与内置浏览器、Coding Plan、插件沙箱的 session 相互隔离；显式代理 / No Proxy / 自定义 CA 策略会覆盖该 partition。

## 4. 与上游 Coding Plan 页的区别

| | NIBI 会员购买页 |
| --- | --- |
| 地址 | `https://nibistudio.top/membership/` |
| 登录态 | 一次性 `handoff` code → 站点 session |
| 桥 | `window.nibiBridge`（只暴露购买完成） |
| 可达性 | 客户端会员入口 |

上游 Coding Plan 页及其 `window.zcodeBridge`、官方 MCP 套餐鉴权、Off-peak/Highspeed 已在 2026-10-22 随上游套餐业务整体移除。
