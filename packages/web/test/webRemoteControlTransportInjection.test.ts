import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWebRemoteControlTransport,
  readInjectedWebRemoteControlTransportFactory,
  WEB_REMOTE_CONTROL_TRANSPORT_FACTORY_GLOBAL,
} from "#src/web-remote-control/adapters/createWebRemoteControlTransport.js";
import type {
  WebRemoteControlExternalTransportFactory,
  WebRemoteControlTerminalTransportOptions,
  WebRemoteControlTransportPort,
} from "#src/web-remote-control/contracts/transport.js";
import { WebRemoteControlTerminalTransport } from "#src/web-remote-control/adapters/webRemoteControlTransport.js";

const options: WebRemoteControlTerminalTransportOptions = {
  relayWsUrl: "wss://relay.example.com/ws",
  deviceSid: "device-1",
  getToken: async () => "token",
  onPayload: vi.fn(),
  onStateChange: vi.fn(),
  onFailure: vi.fn(),
  onError: vi.fn(),
  reloadPage: vi.fn(),
};

const fakePort = {
  start: vi.fn(),
  suspend: vi.fn(),
  dispose: vi.fn(),
  sendPayload: vi.fn(() => true),
  measurePayloadBytes: vi.fn(() => 0),
  sendPayloadResult: vi.fn(),
  recoverConnection: vi.fn(async () => {}),
  recoverInBackground: vi.fn(),
} as unknown as WebRemoteControlTransportPort;

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[WEB_REMOTE_CONTROL_TRANSPORT_FACTORY_GLOBAL];
});

describe("web remote control transport injection", () => {
  it("uses the host factory and forwards the full transport options", () => {
    const factory = vi.fn(() => fakePort);
    expect(createWebRemoteControlTransport(options, factory)).toBe(fakePort);
    expect(factory).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledWith(options);
  });

  it("reads the factory from the documented global", () => {
    const factory = vi.fn(() => fakePort);
    (globalThis as Record<string, unknown>)[WEB_REMOTE_CONTROL_TRANSPORT_FACTORY_GLOBAL] = factory;

    expect(readInjectedWebRemoteControlTransportFactory()).toBe(factory);
    expect(createWebRemoteControlTransport(options)).toBe(fakePort);
  });

  it("ignores a non-function global and keeps the default relay transport", () => {
    (globalThis as Record<string, unknown>)[WEB_REMOTE_CONTROL_TRANSPORT_FACTORY_GLOBAL] = {
      start() {},
    };

    expect(readInjectedWebRemoteControlTransportFactory()).toBeUndefined();
    expect(createWebRemoteControlTransport(options)).toBeInstanceOf(
      WebRemoteControlTerminalTransport,
    );
  });

  it("keeps the default relay transport when no host factory is installed", () => {
    expect(createWebRemoteControlTransport(options)).toBeInstanceOf(
      WebRemoteControlTerminalTransport,
    );
  });

  it("accepts a factory that only implements the public port", () => {
    const factory: WebRemoteControlExternalTransportFactory = () => fakePort;
    expect(factory(options)).toBe(fakePort);
  });
});
