import type { Event, IDisposable } from "@nibi/rpc";
import type { NibiProtocolMessage } from "@nibi/shared";

export type NibiProtocolTransportKind = "stdio" | "websocket" | "memory";

export interface NibiProtocolTransportClosedEvent {
  code?: number | null;
  signal?: NodeJS.Signals | null;
  reason?: string;
}

export interface NibiProtocolTransport extends IDisposable {
  readonly kind: NibiProtocolTransportKind;
  readonly onMessage: Event<NibiProtocolMessage>;
  readonly onClose: Event<NibiProtocolTransportClosedEvent>;
  send(message: NibiProtocolMessage): Promise<void>;
  disposeAndWait?(): Promise<void>;
}
