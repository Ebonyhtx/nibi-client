// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { IFileService } from "@nibi/services";
import {
  collectLiveReloadResourcePaths,
  fileUrlToLocalPath,
  fingerprintLiveReloadResources,
  isLiveReloadResourceChange,
  liveReloadPathKey,
  resolveLiveReloadWatchDirectories,
  shouldLiveReloadForChange,
} from "@/browser-use/useBrowserFileLiveReload.js";

describe("browser file live reload path mapping", () => {
  it("maps file and signed nibi-html preview URLs to local paths, rejects non-local", () => {
    expect(fileUrlToLocalPath("file:///workspace/index.html")).toBe("/workspace/index.html");
    expect(fileUrlToLocalPath("file:///C:/work/index.html")).toBe("C:/work/index.html");
    const signed = `nibi-html://${"a".repeat(64)}/${encodeURIComponent(
      "file:///workspace/",
    )}/style.css`;
    expect(fileUrlToLocalPath(signed)).toBe("/workspace/style.css");
    expect(fileUrlToLocalPath("https://example.com/style.css")).toBeNull();
    expect(fileUrlToLocalPath("data:text/css,body{}")).toBeNull();
    expect(fileUrlToLocalPath("nibi-html://unsigned/style.css")).toBeNull();
  });

  it("tracks only local resources, dedupes and ignores dependency directories", () => {
    const paths = collectLiveReloadResourcePaths("/workspace/index.html", [
      "file:///workspace/index.html",
      "file:///workspace/style.css",
      "file:///workspace/node_modules/pkg/a.css",
      "https://cdn.example.com/a.css",
      "data:text/css,body{}",
      null,
      42,
    ]);
    expect(paths).toEqual(["/workspace/index.html", "/workspace/style.css"]);
    expect(resolveLiveReloadWatchDirectories(paths)).toEqual(["/workspace"]);
    expect(shouldLiveReloadForChange("/workspace/node_modules/a.css")).toBe(false);
    expect(shouldLiveReloadForChange(undefined)).toBe(true);
  });
});

describe("browser file live reload change checks", () => {
  function serviceWithStat(stat: { mtimeMs: number; size: number }, content = "<html></html>") {
    return {
      readDesignSourceFile: vi.fn(async () => ({ content })),
      stat: vi.fn(async () => stat),
    } as unknown as IFileService & {
      readDesignSourceFile: ReturnType<typeof vi.fn>;
      stat: ReturnType<typeof vi.fn>;
    };
  }

  it("only reports page resources, and checks fingerprints when the path is unknown", async () => {
    const service = serviceWithStat({ mtimeMs: 1, size: 10 });
    const resources = await fingerprintLiveReloadResources(service, "/workspace", [
      "/workspace/index.html",
      "/workspace/style.css",
    ]);

    expect(
      await isLiveReloadResourceChange(
        { dirPath: "/workspace", changedPath: "/workspace/style.css" },
        resources,
        service,
        "/workspace",
      ),
    ).toBe(true);
    expect(
      await isLiveReloadResourceChange(
        { dirPath: "/workspace", changedPath: "/workspace/unrelated.txt" },
        resources,
        service,
        "/workspace",
      ),
    ).toBe(false);

    // 不给 changedPath：重新 stat 全部候选，指纹相同则不刷新。
    expect(
      await isLiveReloadResourceChange({ dirPath: "/workspace" }, resources, service, "/workspace"),
    ).toBe(false);
    service.stat.mockResolvedValue({ mtimeMs: 2, size: 11 });
    expect(
      await isLiveReloadResourceChange({ dirPath: "/workspace" }, resources, service, "/workspace"),
    ).toBe(true);
  });

  it("hashes main HTML content so same-size writes with a kept mtime still refresh", async () => {
    const service = serviceWithStat({ mtimeMs: 1, size: 12 }, "<html>one</html>");
    const before = await fingerprintLiveReloadResources(service, "/workspace", [
      "/workspace/index.html",
    ]);
    service.readDesignSourceFile.mockResolvedValue({ content: "<html>two</html>" });
    const after = await fingerprintLiveReloadResources(service, "/workspace", [
      "/workspace/index.html",
    ]);
    expect(before.fingerprints.get(liveReloadPathKey("/workspace/index.html"))).not.toBe(
      after.fingerprints.get(liveReloadPathKey("/workspace/index.html")),
    );
  });
});