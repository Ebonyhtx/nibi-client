import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectedSha256, sha256File } from "../src/packaging/nodeDistIntegrity.js";

const dirs: string[] = [];

async function tempFile(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nibi-node-dist-"));
  dirs.push(dir);
  const path = join(dir, "artifact");
  await writeFile(path, content);
  return path;
}

function stubFetch(body: string, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status })),
  );
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("node dist integrity", () => {
  it("hashes a file", async () => {
    const path = await tempFile("hello");
    expect(await sha256File(path)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("finds the artifact line in SHASUMS256.txt", async () => {
    stubFetch("aaaa node-v22.0.0-linux-x64.tar.xz\r\nbbbb node-v22.0.0-win-x64.zip\n");
    expect(
      await expectedSha256("https://mirror.example/node", "v22.0.0", "node-v22.0.0-win-x64.zip"),
    ).toBe("bbbb");
  });

  it("fails when the list has no such artifact", async () => {
    stubFetch("aaaa other.tar.xz\n");
    await expect(
      expectedSha256("https://mirror.example/node", "v22.0.0", "missing.zip"),
    ).rejects.toThrow(/Could not find missing\.zip/);
  });

  it("fails when the list cannot be fetched", async () => {
    stubFetch("", 503);
    await expect(expectedSha256("https://mirror.example/node", "v22.0.0", "x.zip")).rejects.toThrow(
      /HTTP 503/,
    );
  });
});
