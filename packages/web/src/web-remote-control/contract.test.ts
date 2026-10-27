import { describe, expect, it, vi } from "vitest";
import { WebRemoteControlEntry } from "#src/web-remote-control/index.js";

describe("mobile entry public boundary", () => {
  it("ignores an old list response after disposal", async () => {
    let finish!: (devices: []) => void;
    const devices = vi.fn(
      () =>
        new Promise<[]>((resolve) => {
          finish = resolve;
        }),
    );
    const onView = vi.fn();
    const connect = vi.fn();
    const unsubscribe = vi.fn();
    const entry = new WebRemoteControlEntry({
      auth: {
        getZCodeJwtToken: () => "jwt",
        getActiveAccount: () => null,
        startLogin: vi.fn(),
        logout: vi.fn(async () => {}),
        refreshNibiSessionIfNeeded: vi.fn(async () => false),
      },
      getHref: () => "https://relay.example.com/remote/v4",
      replaceHref: vi.fn(),
      storage: { getItem: () => null, setItem: vi.fn() },
      locale: "en-US",
      devices,
      subscribeVisible: () => unsubscribe,
      token: vi.fn(),
      connect,
      onView,
    });
    const start = entry.start();
    // start() 先 await 一次令牌续期检查（未登录时立即返回），再决定视图。
    await Promise.resolve();
    await Promise.resolve();
    expect(onView).toHaveBeenCalledOnce();
    entry.dispose();
    finish([]);
    await start;
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(onView).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
  });
});
