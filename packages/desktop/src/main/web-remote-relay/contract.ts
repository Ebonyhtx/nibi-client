import type { AppSettings, WebRemoteControlAppPayload } from "@nibi/shared";
import type { WebRemoteControlRelayV2Meta } from "@nibi/shared/web-remote-relay";

export type WebRemoteControlRegisteredDevice = NonNullable<
  AppSettings["webRemoteControlRelayV2Device"]
>;
export interface WebRemoteControlDeviceStorage {
  load(): Promise<WebRemoteControlRegisteredDevice | undefined>;
  save(device: WebRemoteControlRegisteredDevice): Promise<void>;
  clearLegacy(): Promise<void>;
}

export interface WebRemoteControlLogin {
  userId: string;
  jwt: string;
}

export type WebRemoteControlDeviceTransportState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "waiting_terminal"
  | "paired"
  | "kicked"
  | "error";

export interface WebRemoteControlDeviceTransportOptions {
  relayWsUrl: string;
  deviceMid: string;
  meta: WebRemoteControlRelayV2Meta;
  /**
   * 建连前解析代理（应用设置里的 httpProxy / noProxy）。返回 undefined 表示直连，
   * 也是未配置代理时的唯一路径；不能把“没有代理”变成另一种连接实现。
   */
  resolveProxyAgent?(url: string): Promise<import("node:http").Agent | undefined>;
  getToken(signal: AbortSignal): Promise<string>;
  resolveDeviceSid(signal: AbortSignal, forceRegistration: boolean): Promise<string>;
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  onStateChange(state: WebRemoteControlDeviceTransportState): void;
  onPayload(payload: WebRemoteControlAppPayload): void;
  onRawTransportPayload?(payload: unknown): boolean;
  onRawTransportFault?(reasonCode: string): void;
  onError(error: Error): void;
  onSendReady?(event: { kind: "same-socket" | "reconnected-socket" }): void;
}
