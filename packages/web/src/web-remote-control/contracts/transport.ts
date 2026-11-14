import type { WebRemoteControlPayloadSendResult } from "@nibi/client";
import type { WebRemoteControlAppPayload, WebRemoteControlFailure } from "@nibi/shared";

export type WebRemoteControlTerminalTransportState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "waiting"
  | "paired"
  | "reconnecting"
  | "suspended"
  | "kicked"
  | "error";

export type WebRemoteControlTerminalTransportDiagnostic =
  | {
      type: "state-transition";
      previousState: WebRemoteControlTerminalTransportState;
      state: WebRemoteControlTerminalTransportState;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    }
  | {
      type: "socket-close";
      code: number;
      reason: string;
      wasClean: boolean;
      wasPaired: boolean;
      state: WebRemoteControlTerminalTransportState;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    }
  | {
      type: "socket-error" | "recover-start" | "recover-scheduled";
      state: WebRemoteControlTerminalTransportState;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    }
  | {
      type: "pair-status";
      pairStatus: "waiting" | "matched";
      state: WebRemoteControlTerminalTransportState;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    }
  | {
      type: "socket-extensions";
      state: WebRemoteControlTerminalTransportState;
      perMessageDeflate: boolean;
      extensions?: string;
      timestamp: number;
      visibilityState: string;
      online: boolean;
      hiddenDurationMs?: number;
    };

export type WebRemoteControlTerminalTransportDiagnosticInput = {
  type: WebRemoteControlTerminalTransportDiagnostic["type"];
  previousState?: WebRemoteControlTerminalTransportState;
  state: WebRemoteControlTerminalTransportState;
  code?: number;
  reason?: string;
  wasClean?: boolean;
  wasPaired?: boolean;
  pairStatus?: "waiting" | "matched";
  perMessageDeflate?: boolean;
  extensions?: string;
};

export interface WebRemoteControlTerminalTransportOptions {
  relayWsUrl: string;
  deviceSid: string;
  getToken(signal: AbortSignal): Promise<string>;
  deviceMid?: string;
  appVersion?: string;
  WebSocketCtor?: typeof globalThis.WebSocket;
  heartbeatIntervalMs?: number;
  heartbeatJitterMs?: number;
  heartbeatAckTimeoutMs?: number;
  reconnectJitterMs?: number;
  healthCheckTimeoutMs?: number;
  desktopOfflineGraceMs?: number;
  staleWaitingRecoveryMs?: number;
  waitingTimeoutMs?: number;
  onPayload(payload: WebRemoteControlAppPayload): void;
  onRawTransportPayload?(payload: unknown): boolean;
  onRawTransportFault?(reasonCode: string): void;
  onStateChange(state: WebRemoteControlTerminalTransportState): void;
  onFailure(failure: WebRemoteControlFailure): void;
  onError(error: Error): void;
  onDiagnostic?(diagnostic: WebRemoteControlTerminalTransportDiagnostic): void;
  onSendReady?(event: { kind: "same-socket" | "reconnected-socket" }): void;
  reloadPage(): void;
}

/**
 * 编排层只依赖这组行为，不关心 transport 是 web 自建 relay 还是宿主原生隧道。
 * 方法集合与 `WebRemoteControlTerminalTransport` 的公开面保持一致，宿主实现必须逐项满足。
 */
export interface WebRemoteControlTransportPort {
  start(): void;
  suspend(): void;
  dispose(): void;
  sendPayload(payload: WebRemoteControlAppPayload): boolean;
  measurePayloadBytes(payload: WebRemoteControlAppPayload): number;
  sendPayloadResult(payload: WebRemoteControlAppPayload): WebRemoteControlPayloadSendResult;
  recoverConnection(timeoutMs?: number): Promise<void>;
  recoverInBackground(): void;
}

/**
 * 宿主注入的 transport 工厂。NIBI-GO 的 WebView 在加载页面前把它挂到
 * `globalThis.__nibiWebRemoteControlTransportFactory`；浏览器 PWA 永远不设置，走默认实现。
 */
export type WebRemoteControlExternalTransportFactory = (
  options: WebRemoteControlTerminalTransportOptions,
) => WebRemoteControlTransportPort;
