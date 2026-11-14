import type {
  WebRemoteControlExternalTransportFactory,
  WebRemoteControlTerminalTransportOptions,
  WebRemoteControlTransportPort,
} from "#src/web-remote-control/contracts/transport.js";
import { WebRemoteControlTerminalTransport } from "#src/web-remote-control/adapters/webRemoteControlTransport.js";

/** NIBI-GO 原生宿主在 WebView 加载页面前挂载的全局注入点。 */
export const WEB_REMOTE_CONTROL_TRANSPORT_FACTORY_GLOBAL =
  "__nibiWebRemoteControlTransportFactory" as const;

type GlobalWithTransportFactory = typeof globalThis & {
  [WEB_REMOTE_CONTROL_TRANSPORT_FACTORY_GLOBAL]?: unknown;
};

/** 只接受函数；浏览器 PWA 没有注入时返回 undefined，保持默认自建 relay。 */
export function readInjectedWebRemoteControlTransportFactory(
  globalObject: GlobalWithTransportFactory = globalThis,
): WebRemoteControlExternalTransportFactory | undefined {
  const candidate = globalObject[WEB_REMOTE_CONTROL_TRANSPORT_FACTORY_GLOBAL];
  return typeof candidate === "function"
    ? (candidate as WebRemoteControlExternalTransportFactory)
    : undefined;
}

/**
 * 有宿主注入时用宿主 transport，否则用 web 自建 relay。注入实现拿到同一份
 * `WebRemoteControlTerminalTransportOptions`（状态回调、帧回调、getToken 等），
 * 可以忽略 relay 参数，但必须按契约回调状态与帧。
 */
export function createWebRemoteControlTransport(
  options: WebRemoteControlTerminalTransportOptions,
  factory: WebRemoteControlExternalTransportFactory | undefined =
    readInjectedWebRemoteControlTransportFactory(),
): WebRemoteControlTransportPort {
  if (factory) return factory(options);
  return new WebRemoteControlTerminalTransport(options);
}
