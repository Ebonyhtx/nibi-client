import { describe, expect, it, vi } from "vitest";
import { EMBEDDED_BROWSER_DESIGN_BRIDGE, EmbeddedBrowserWebviewChannels } from "@nibi/shared";
import {
  installEmbeddedBrowserDesignBridge,
  isEmbeddedBrowserDesignSourceUrl,
  readEmbeddedBrowserDesignMessage,
} from "../src/preload/embeddedBrowserDesignBridge.js";

const SIGNED_URL = `nibi-html://${"a".repeat(64)}/${encodeURIComponent("file:///workspace/")}/index.html`;

function targetWindow(href: string): Window {
  return { location: { href } } as unknown as Window;
}

function message(data: unknown, source: unknown): Pick<MessageEvent, "data" | "source"> {
  return { data, source };
}

describe("embedded browser design preload bridge", () => {
  it("accepts a namespaced envelope from the same local preview window", () => {
    const window = targetWindow(SIGNED_URL);
    const events = [{ type: "mode-changed", mode: "select" }];
    const data = { [EMBEDDED_BROWSER_DESIGN_BRIDGE.messageKey]: 1, events };
    expect(readEmbeddedBrowserDesignMessage(message(data, window), window)).toBe(events);
  });

  it("accepts raw local file pages but rejects network shares", () => {
    expect(isEmbeddedBrowserDesignSourceUrl("file:///workspace/index.html")).toBe(true);
    expect(isEmbeddedBrowserDesignSourceUrl("file://server/share/index.html")).toBe(false);
    expect(isEmbeddedBrowserDesignSourceUrl("https://example.com")).toBe(false);
    expect(isEmbeddedBrowserDesignSourceUrl("nibi-html://unsigned/a.html")).toBe(false);
    expect(isEmbeddedBrowserDesignSourceUrl("about:blank")).toBe(false);
  });

  it("rejects messages from another window or another page protocol", () => {
    const window = targetWindow(SIGNED_URL);
    const data = { [EMBEDDED_BROWSER_DESIGN_BRIDGE.messageKey]: 1, events: [{ type: "x" }] };
    expect(readEmbeddedBrowserDesignMessage(message(data, {}), window)).toBeNull();

    const remote = targetWindow("https://example.com/page");
    expect(readEmbeddedBrowserDesignMessage(message(data, remote), remote)).toBeNull();
  });

  it("rejects malformed envelopes and oversized payloads", () => {
    const window = targetWindow(SIGNED_URL);
    expect(readEmbeddedBrowserDesignMessage(message(null, window), window)).toBeNull();
    expect(readEmbeddedBrowserDesignMessage(message({ events: [{}] }, window), window)).toBeNull();
    expect(
      readEmbeddedBrowserDesignMessage(
        message({ [EMBEDDED_BROWSER_DESIGN_BRIDGE.messageKey]: 1, events: [] }, window),
        window,
      ),
    ).toBeNull();
    expect(
      readEmbeddedBrowserDesignMessage(
        message(
          {
            [EMBEDDED_BROWSER_DESIGN_BRIDGE.messageKey]: 1,
            events: [{ text: "x".repeat(EMBEDDED_BROWSER_DESIGN_BRIDGE.maxMessageBytes) }],
          },
          window,
        ),
        window,
      ),
    ).toBeNull();
  });

  it("forwards only validated events on the design channel and unbinds cleanly", () => {
    const listeners = new Set<(event: MessageEvent) => void>();
    const window = {
      location: { href: SIGNED_URL },
      addEventListener: vi.fn((_type: string, listener: (event: MessageEvent) => void) => {
        listeners.add(listener);
      }),
      removeEventListener: vi.fn((_type: string, listener: (event: MessageEvent) => void) => {
        listeners.delete(listener);
      }),
    } as unknown as Window;
    const sendToHost = vi.fn();
    const dispose = installEmbeddedBrowserDesignBridge(window, sendToHost);

    const events = [{ type: "selection-changed", selections: [] }];
    for (const listener of listeners) {
      listener({
        data: { [EMBEDDED_BROWSER_DESIGN_BRIDGE.messageKey]: 1, events },
        source: window,
      } as unknown as MessageEvent);
    }
    expect(sendToHost).toHaveBeenCalledWith(EmbeddedBrowserWebviewChannels.DesignEvents, events);

    dispose();
    expect(listeners.size).toBe(0);
  });
});
