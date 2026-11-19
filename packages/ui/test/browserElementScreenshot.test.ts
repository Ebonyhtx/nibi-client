// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { captureBrowserElementScreenshot } from "@/browser-use/browserElementScreenshot.js";

function webview(viewport: unknown, webContentsId = 7) {
  return {
    getWebContentsId: () => webContentsId,
    executeJavaScript: vi.fn(async () => viewport),
  };
}

describe("captureBrowserElementScreenshot", () => {
  it("passes the CSS rect and measured viewport to main and returns the PNG bytes", async () => {
    const data = new Uint8Array([1, 2, 3]).buffer;
    const captureGuestPage = vi.fn(async () => ({ success: true, data }));
    const target = webview({ width: 1000, height: 800 });
    const rect = { x: 10, y: 20, width: 100, height: 50 };

    await expect(
      captureBrowserElementScreenshot({
        captureGuestPage,
        key: "tab-1",
        rect,
        webview: target as unknown as Parameters<typeof captureBrowserElementScreenshot>[0]["webview"],
      }),
    ).resolves.toBe(data);
    expect(captureGuestPage).toHaveBeenCalledWith({
      key: "tab-1",
      webContentsId: 7,
      clip: {
        x: 10,
        y: 20,
        width: 100,
        height: 50,
        viewportWidth: 1000,
        viewportHeight: 800,
      },
    });
  });

  it("returns null for a missing guest or an invalid viewport instead of calling main", async () => {
    const captureGuestPage = vi.fn(async () => ({ success: true }));
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    await expect(
      captureBrowserElementScreenshot({
        captureGuestPage,
        key: "tab-1",
        rect,
        webview: webview({ width: 0, height: 800 }, 0) as never,
      }),
    ).resolves.toBeNull();
    expect(captureGuestPage).not.toHaveBeenCalled();

    await expect(
      captureBrowserElementScreenshot({
        captureGuestPage,
        key: "tab-1",
        rect,
        webview: webview({ width: 0, height: 0 }) as never,
      }),
    ).resolves.toBeNull();
    expect(captureGuestPage).not.toHaveBeenCalled();
  });
});