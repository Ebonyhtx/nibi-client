import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  addMarketplace,
  assertMarketplaceRevisionNotRolledBack,
  loadKnownMarketplacesSync,
  updateMarketplace,
} from "../src/plugins/index.js";

// 官方清单完整性：签名只证明「这份字节是我们发的」，防回滚靠单调 revision。
// 签名算法/烘焙公钥/主机白名单在 packages/shared/test/nibiContentSignature.test.ts 覆盖；
// 这里覆盖「拒绝倒退」的判据、非官方来源不受影响的边界，以及刷新失败不丢快照。
describe("marketplace manifest 防回滚", () => {
  const cleanups: string[] = [];
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
    await Promise.all(
      servers.splice(0).map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  });

  async function makeStorageRoot(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "nibi-marketplace-revision-"));
    cleanups.push(dir);
    return dir;
  }

  function manifestFor(name: string, revision?: number): Record<string, unknown> {
    return {
      name,
      ...(revision === undefined ? {} : { revision }),
      plugins: [
        {
          name: "demo",
          version: "1.0.0",
          source: { source: "url", type: "zip", url: "https://example.com/demo-1.0.0.zip" },
        },
      ],
    };
  }

  /** 起一个本地 http 源；body 可以是函数，便于同一 URL 前后换内容。 */
  async function serve(body: unknown | (() => unknown), status = 200): Promise<string> {
    const server = createServer((request, response) => {
      if (request.url !== "/marketplace.json") {
        response.writeHead(404).end("not found");
        return;
      }
      if (status !== 200) {
        response.writeHead(status).end("boom");
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(typeof body === "function" ? body() : body));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server address unavailable");
    return `http://127.0.0.1:${address.port}/marketplace.json`;
  }

  function writeKnownMarketplace(
    storageRoot: string,
    record: Record<string, unknown>,
  ): Promise<void> {
    return writeFile(
      join(storageRoot, "known_marketplaces.json"),
      JSON.stringify({ version: 1, marketplaces: [record] }),
    );
  }

  it("判据：无上次记录 / 持平 / 更高都放行，倒退才拒绝", () => {
    expect(() =>
      assertMarketplaceRevisionNotRolledBack({ previousRevision: undefined, revision: 3 }),
    ).not.toThrow();
    expect(() =>
      assertMarketplaceRevisionNotRolledBack({ previousRevision: 3, revision: 3 }),
    ).not.toThrow();
    expect(() =>
      assertMarketplaceRevisionNotRolledBack({ previousRevision: 3, revision: 4 }),
    ).not.toThrow();
    expect(() =>
      assertMarketplaceRevisionNotRolledBack({ previousRevision: 3, revision: 2 }),
    ).toThrow(/went backwards: 2 < 3/);
  });

  it("没有 revision 的来源（用户自加市场/内置 seed）不参与比较", () => {
    expect(() =>
      assertMarketplaceRevisionNotRolledBack({ previousRevision: 9, revision: undefined }),
    ).not.toThrow();
  });

  it("用户自加的 url 源不要求 revision，且不写 manifestRevision", async () => {
    const storageRoot = await makeStorageRoot();
    const url = await serve(manifestFor("user-market"));
    const record = await addMarketplace({ source: { source: "url", url }, storageRoot });
    expect(record.id).toBe("user-market");
    expect(record.manifestRevision).toBeUndefined();
  });

  it("带 revision 的源：先记录，再前进通过，最后倒退被拒且不覆盖记录", async () => {
    const storageRoot = await makeStorageRoot();
    let current: Record<string, unknown> = manifestFor("revisioned-market", 5);
    const url = await serve(() => current);

    const first = await addMarketplace({ source: { source: "url", url }, storageRoot });
    expect(first.manifestRevision).toBe(5);

    current = manifestFor("revisioned-market", 6);
    const forward = await addMarketplace({ source: { source: "url", url }, storageRoot });
    expect(forward.manifestRevision).toBe(6);

    // 同一 URL 换回旧内容（旧签名清单重放）：刷新失败，记录仍是 6。
    current = manifestFor("revisioned-market", 5);
    await expect(updateMarketplace({ storageRoot, marketplace: "revisioned-market" })).resolves.toHaveLength(
      0,
    );
    const afterStale = loadKnownMarketplacesSync(storageRoot).find(
      (item) => item.id === "revisioned-market",
    );
    expect(afterStale?.manifestRevision).toBe(6);
    expect(afterStale?.lastRefreshFailure?.message).toMatch(/went backwards/);
  });

  it("刷新失败（5xx）保留上一份记录，并把失败写进 lastRefreshFailure", async () => {
    const storageRoot = await makeStorageRoot();
    const url = await serve({}, 500);
    await writeKnownMarketplace(storageRoot, {
      id: "user-market",
      source: { source: "url", url },
      name: "user-market",
      addedAt: "2026-01-01T00:00:00.000Z",
      lastUpdated: "2026-01-01T00:00:00.000Z",
      pluginCount: 1,
    });

    const updated = await updateMarketplace({ storageRoot, marketplace: "user-market" });
    expect(updated).toHaveLength(0);
    const after = loadKnownMarketplacesSync(storageRoot).find((item) => item.id === "user-market");
    expect(after?.lastUpdated).toBe("2026-01-01T00:00:00.000Z");
    expect(after?.lastRefreshFailure?.message.length).toBeGreaterThan(0);
  });
});
