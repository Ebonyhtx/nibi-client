import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeBrowserCommandOnView,
  type ControlledView,
} from "../src/main/browserView/browserCommandExecutor.js";

const { resolveMock } = vi.hoisted(() => ({ resolveMock: vi.fn() }));

vi.mock("../src/main/browserLocalPreview/index.js", () => ({
  resolveBrowserLocalPreviewNavigation: resolveMock,
}));

function makeView(loadURL = vi.fn(async () => {})): ControlledView {
  return {
    webContents: {
      loadURL,
      getURL: () => "https://example.com/",
      getTitle: () => "Example",
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: () => {},
      goForward: () => {},
      reload: () => {},
      executeJavaScript: vi.fn(async () => null),
    },
    cdp: { send: vi.fn(async () => ({})) },
  };
}

beforeEach(() => {
  resolveMock.mockReset();
});

describe("navigate supersession", () => {
  it("does not load a stale file resolution after a newer navigation started", async () => {
    const loadURL = vi.fn(async () => {});
    const view = makeView(loadURL);
    let resolveFirst!: (url: string) => void;
    resolveMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    resolveMock.mockImplementationOnce(async (url: string) => url);

    const first = executeBrowserCommandOnView(view, {
      method: "navigate",
      url: "file:///tmp/first.html",
    });
    const second = executeBrowserCommandOnView(view, {
      method: "navigate",
      url: "https://example.com/newer",
    });
    await second;

    resolveFirst("nibi-html://stale/root/first.html");
    const firstResult = await first;

    expect(firstResult.ok).toBe(false);
    expect(firstResult.error?.code).toBe("cancelled");
    expect(loadURL).toHaveBeenCalledTimes(1);
    expect(loadURL).toHaveBeenCalledWith("https://example.com/newer");
  });

  it("does not surface a stale resolution error after a newer navigation started", async () => {
    const loadURL = vi.fn(async () => {});
    const view = makeView(loadURL);
    let rejectFirst!: (error: Error) => void;
    resolveMock.mockImplementationOnce(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    resolveMock.mockImplementationOnce(async (url: string) => url);

    const first = executeBrowserCommandOnView(view, {
      method: "navigate",
      url: "file:///tmp/outside.html",
    });
    await executeBrowserCommandOnView(view, {
      method: "navigate",
      url: "https://example.com/newer",
    });

    rejectFirst(new Error("HTML is outside the preview directory"));
    const firstResult = await first;

    // 旧文件的错误不能覆盖已经成功的新页面；结果只标记本次请求被新导航取代。
    expect(firstResult.ok).toBe(false);
    expect(firstResult.error?.code).toBe("cancelled");
    expect(firstResult.error?.message).not.toContain("outside the preview directory");
  });

  it("reports navigation_blocked when the current preview resolution fails", async () => {
    const loadURL = vi.fn(async () => {});
    const view = makeView(loadURL);
    resolveMock.mockImplementationOnce(async () => {
      throw new Error("Only local HTML can be previewed");
    });

    const result = await executeBrowserCommandOnView(view, {
      method: "navigate",
      url: "file:///tmp/notes.txt",
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("navigation_blocked");
    expect(result.error?.message).toContain("Only local HTML can be previewed");
    expect(loadURL).not.toHaveBeenCalled();
  });
});
