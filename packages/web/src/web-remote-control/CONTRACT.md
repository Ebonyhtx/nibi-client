# web-remote-control

手机远控 admission、设备列表、transport 与只读页面。

入口通过 auth/HTTP/location/storage 端口操作外部状态；契约的设备分组与缓存展示类型不依赖实现。entry 的 AbortSignal 控制本次导航；transport 的 socket/generation 控制连接。只提取帧解析与独立请求关联，不创建第二份恢复 owner。Main/Host/CLI 继续拥有业务状态，手机仍为 replayable。

bootstrap 请求只读取响应。version guard 校验当前请求代际与版本后，同步通过 `onAccepted` 提交查看 epoch 等接受副作用；失效、释放或版本不匹配的回包不得产生该副作用。

完整语义见 [Relay V2 spec](../../../../docs/web-remote-control/relay-v2-pairing.md)。

## 宿主 transport 注入

NIBI-GO 的 WebView 可在加载页面前设置
`globalThis.__nibiWebRemoteControlTransportFactory = (options) => transport`，让原生 RelayTransport
持有连接与 E2E 信封，web UI 只消费状态与帧。`transport` 必须实现
`WebRemoteControlTransportPort`（`start` / `suspend` / `dispose` / `sendPayload` /
`sendPayloadResult` / `measurePayloadBytes` / `recoverConnection` / `recoverInBackground`），
并通过 `options.onPayload`、`options.onRawTransportPayload`、`options.onStateChange`、
`options.onFailure` 等回调把帧和状态交回编排层。不设置该全局时，浏览器 PWA 与现有构建
继续使用自建 relay，行为不变。
