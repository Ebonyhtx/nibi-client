import { describe, expect, it, vi } from "vitest";
import { EMBEDDED_BROWSER_DESIGN_BRIDGE, EmbeddedBrowserWebviewChannels } from "@nibi/shared";
import {
  installEmbeddedBrowserDesignBridge,
  isEmbeddedBrowserDesignSourceUrl,
  readEmbeddedBrowserDesignMessage,
  readEmbeddedBrowserDesignUndoKey,
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

  it("forwards only trusted undo shortcuts that are not aimed at page inputs", () => {
    const event = (overrides: Partial<KeyboardEvent> = {}): KeyboardEvent =>
      ({
        altKey: false,
        composedPath: () => [],
        ctrlKey: false,
        isTrusted: true,
        key: "z",
        metaKey: false,
        repeat: false,
        shiftKey: false,
        ...overrides,
      }) as unknown as KeyboardEvent;

    expect(readEmbeddedBrowserDesignUndoKey(event({ ctrlKey: true }))).toEqual({ redo: false });
    expect(
      readEmbeddedBrowserDesignUndoKey(event({ metaKey: true, shiftKey: true })),
    ).toEqual({ redo: true });
    // 页面脚本 dispatchEvent 造不出 isTrusted
    expect(readEmbeddedBrowserDesignUndoKey(event({ ctrlKey: true, isTrusted: false }))).toBeNull();
    expect(readEmbeddedBrowserDesignUndoKey(event({ altKey: true, ctrlKey: true }))).toBeNull();
    expect(readEmbeddedBrowserDesignUndoKey(event({ ctrlKey: true, repeat: true }))).toBeNull();
    expect(readEmbeddedBrowserDesignUndoKey(event({ ctrlKey: true, key: "x" }))).toBeNull();
  });

  it("forwards page undo shortcuts on the undo channel only from a local preview page", () => {
    const listeners = new Map<string, Set<(event: unknown) => void>>();
    const window = {
      location: { href: SIGNED_URL },
      addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
        const set = listeners.get(type) ?? new Set();
        set.add(listener);
        listeners.set(type, set);
      }),
      removeEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
        listeners.get(type)?.delete(listener);
      }),
    } as unknown as Window;
    const sendToHost = vi.fn();
    const dispose = installEmbeddedBrowserDesignBridge(window, sendToHost);

    const keyboardEvent = {
      altKey: false,
      composedPath: () => [],
      ctrlKey: true,
      isTrusted: true,
      key: "z",
      metaKey: false,
      repeat: false,
      shiftKey: true,
    } as unknown as KeyboardEvent;
    for (const listener of listeners.get("keydown") ?? []) listener(keyboardEvent);

    expect(sendToHost).toHaveBeenCalledWith(
      EmbeddedBrowserWebviewChannels.DesignUndoShortcut,
      { redo: true },
    );
    dispose();
    expect(listeners.get("keydown")?.size ?? 0).toBe(0);
  });
});
