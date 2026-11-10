import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, parse } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_LOCAL_PREVIEW_PRIVILEGES,
  createBrowserLocalPreview,
  installBrowserLocalPreview,
  resolveBrowserLocalPreviewNavigation,
  type BrowserLocalPreviewFileFetcher,
} from "../src/main/browserLocalPreview/index.js";
import {
  executeBrowserCommandOnView,
  type ControlledView,
} from "../src/main/browserView/browserCommandExecutor.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nibi-browser-preview-"));
  tempDirs.push(dir);
  return dir;
}

async function makeFixture(
  name = "index.html",
  content = "<!doctype html><h1>preview</h1>",
): Promise<{ dir: string; file: string; url: string }> {
  const dir = await makeTempDir();
  const file = join(dir, name);
  await writeFile(file, content, "utf8");
  return { dir, file, url: pathToFileURL(file).href };
}

const readFileFetcher: BrowserLocalPreviewFileFetcher = async (fileUrl, method) => {
  const body = method === "HEAD" ? null : new Uint8Array(await readFile(fileURLToPath(fileUrl)));
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
};

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

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("browserLocalPreview privileged scheme", () => {
  it("registers nibi-html as a standard, secure, fetchable scheme", () => {
    expect(BROWSER_LOCAL_PREVIEW_PRIVILEGES).toEqual({
      scheme: "nibi-html",
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    });
  });
});

describe("resolveNavigation", () => {
  it("converts a local HTML file into a signed directory URL and keeps search/hash", async () => {
    const fixture = await makeFixture();
    const preview = createBrowserLocalPreview();
    const signed = await preview.resolveNavigation(`${fixture.url}?mode=1#top`);

    const url = new URL(signed);
    expect(url.protocol).toBe("nibi-html:");
    expect(url.hostname).toMatch(/^[a-f0-9]{64}$/);
    expect(url.search).toBe("?mode=1");
    expect(url.hash).toBe("#top");
    expect(decodeURIComponent(url.pathname.split("/").at(-1) ?? "")).toBe("index.html");
  });

  it("leaves non-file URLs untouched", async () => {
    const preview = createBrowserLocalPreview();
    await expect(preview.resolveNavigation("https://example.com/a?b=1")).resolves.toBe(
      "https://example.com/a?b=1",
    );
    await expect(preview.resolveNavigation("about:blank")).resolves.toBe("about:blank");
  });

  it("rejects non-HTML files", async () => {
    const fixture = await makeFixture("notes.txt", "not html");
    const preview = createBrowserLocalPreview({ fetchFile: readFileFetcher });
    await expect(preview.resolveNavigation(fixture.url)).rejects.toThrow(
      "Only local HTML can be previewed",
    );
  });

  it("rejects file URLs with a host (UNC/network share)", async () => {
    const preview = createBrowserLocalPreview();
    await expect(preview.resolveNavigation("file://server/share/page.html")).rejects.toThrow(
      "Only local HTML can be previewed",
    );
  });

  it("rejects a file directly in the filesystem root", async () => {
    const preview = createBrowserLocalPreview({
      realpath: async (path) => path,
      isRegularFile: async () => true,
    });
    const rootFile = join(parse(process.cwd()).root, "page.html");
    await expect(preview.resolveNavigation(pathToFileURL(rootFile).href)).rejects.toThrow(
      "HTML is outside the preview directory",
    );
  });

  it("rejects a hidden preview root directory", async () => {
    const parent = await makeTempDir();
    const hidden = join(parent, ".hidden");
    await mkdir(hidden);
    const file = join(hidden, "page.html");
    await writeFile(file, "<h1>hidden</h1>", "utf8");
    const preview = createBrowserLocalPreview();
    await expect(preview.resolveNavigation(pathToFileURL(file).href)).rejects.toThrow(
      "HTML is outside the preview directory",
    );
  });

  it("rejects a file whose realpath escapes the preview root", async () => {
    const root = join(parse(process.cwd()).root, "preview-root");
    const file = join(root, "page.html");
    const outside = join(parse(process.cwd()).root, "outside", "page.html");
    const preview = createBrowserLocalPreview({
      realpath: async (path) => (basename(path) === "page.html" ? outside : root),
      isRegularFile: async () => true,
    });
    await expect(preview.resolveNavigation(pathToFileURL(file).href)).rejects.toThrow(
      "HTML is outside the preview directory",
    );
  });
});

describe("respond", () => {
  it("serves a signed file with no-store and nosniff", async () => {
    const fixture = await makeFixture("index.html", "<h1>served</h1>");
    const preview = createBrowserLocalPreview({ fetchFile: readFileFetcher });
    const signed = await preview.resolveNavigation(fixture.url);

    const response = await preview.respond(new Request(signed));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe("<h1>served</h1>");
  });

  it("answers HEAD without a body", async () => {
    const fixture = await makeFixture();
    const preview = createBrowserLocalPreview({ fetchFile: readFileFetcher });
    const signed = await preview.resolveNavigation(fixture.url);

    const response = await preview.respond(new Request(signed, { method: "HEAD" }));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
  });

  it("rejects a tampered signature with 403", async () => {
    const fixture = await makeFixture();
    const preview = createBrowserLocalPreview({ fetchFile: readFileFetcher });
    const signed = new URL(await preview.resolveNavigation(fixture.url));
    signed.hostname = "0".repeat(64);

    expect((await preview.respond(new Request(signed.href))).status).toBe(403);
  });

  it("rejects dot segments with 403 (percent-encoded so the URL parser keeps them)", async () => {
    const fixture = await makeFixture();
    const preview = createBrowserLocalPreview({ fetchFile: readFileFetcher });
    const signed = new URL(await preview.resolveNavigation(fixture.url));
    const encodedRoot = signed.pathname.split("/")[1] ?? "";

    for (const segment of ["%2E%2E", "%2E", ".hidden"]) {
      const requestUrl = `${signed.protocol}//${signed.hostname}/${encodedRoot}/${segment}`;
      expect((await preview.respond(new Request(requestUrl))).status).toBe(403);
    }
  });

  it("returns 405 for non-GET/HEAD methods", async () => {
    const fixture = await makeFixture();
    const preview = createBrowserLocalPreview({ fetchFile: readFileFetcher });
    const signed = await preview.resolveNavigation(fixture.url);

    const response = await preview.respond(new Request(signed, { method: "POST" }));
    expect(response.status).toBe(405);
  });

  it("returns 404 for directories and missing files", async () => {
    const fixture = await makeFixture();
    const preview = createBrowserLocalPreview({ fetchFile: readFileFetcher });
    const signed = new URL(await preview.resolveNavigation(fixture.url));
    const encodedRoot = signed.pathname.split("/")[1] ?? "";
    await mkdir(join(fixture.dir, "sub"));

    const directory = `${signed.protocol}//${signed.hostname}/${encodedRoot}/sub`;
    const missing = `${signed.protocol}//${signed.hostname}/${encodedRoot}/missing.html`;
    expect((await preview.respond(new Request(directory))).status).toBe(404);
    expect((await preview.respond(new Request(missing))).status).toBe(404);
  });

  it("rejects a wrong scheme even with a valid host shape", async () => {
    const fixture = await makeFixture();
    const preview = createBrowserLocalPreview({ fetchFile: readFileFetcher });
    const signed = new URL(await preview.resolveNavigation(fixture.url));
    const requestUrl = `https://${signed.hostname}${signed.pathname}`;

    expect((await preview.respond(new Request(requestUrl))).status).toBe(403);
  });
});

describe("installBrowserLocalPreview", () => {
  it("blocks raw file: and serves nibi-html on the given partition only", async () => {
    const handlers = new Map<string, (request: Request) => Promise<Response> | Response>();
    const session = {
      protocol: {
        handle: (scheme: string, handler: (request: Request) => Promise<Response> | Response) => {
          handlers.set(scheme, handler);
        },
      },
    };
    installBrowserLocalPreview(session, { fetchFile: readFileFetcher });

    expect([...handlers.keys()]).toEqual(["file", "nibi-html"]);
    const blocked = await handlers.get("file")!(new Request("file:///etc/passwd"));
    expect(blocked.type).toBe("error");

    const fixture = await makeFixture();
    const signed = await resolveBrowserLocalPreviewNavigation(fixture.url);
    const served = await handlers.get("nibi-html")!(new Request(signed));
    expect(served.status).toBe(200);
  });
});

describe("navigate command with local preview", () => {
  it("loads the signed nibi-html URL instead of the raw file URL", async () => {
    const fixture = await makeFixture();
    const loadURL = vi.fn(async () => {});
    const view = makeView(loadURL);

    const result = await executeBrowserCommandOnView(view, {
      method: "navigate",
      url: `${fixture.url}?x=1`,
    });

    expect(result.ok).toBe(true);
    expect(loadURL).toHaveBeenCalledTimes(1);
    const loaded = loadURL.mock.calls[0]?.[0] as string;
    expect(loaded.startsWith("nibi-html://")).toBe(true);
    expect(loaded).not.toBe(fixture.url);
    expect(new URL(loaded).search).toBe("?x=1");
  });

  it("fails closed without loading the raw file when preview resolution rejects", async () => {
    const fixture = await makeFixture("notes.txt", "not html");
    const loadURL = vi.fn(async () => {});
    const view = makeView(loadURL);

    const result = await executeBrowserCommandOnView(view, {
      method: "navigate",
      url: fixture.url,
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("navigation_blocked");
    expect(loadURL).not.toHaveBeenCalled();
  });

  it("keeps ordinary http(s) navigation unchanged", async () => {
    const loadURL = vi.fn(async () => {});
    const view = makeView(loadURL);

    const result = await executeBrowserCommandOnView(view, {
      method: "navigate",
      url: "https://example.com/page",
    });

    expect(result.ok).toBe(true);
    expect(loadURL).toHaveBeenCalledWith("https://example.com/page");
  });
});
