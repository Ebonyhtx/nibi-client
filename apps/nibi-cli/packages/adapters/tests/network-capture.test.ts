import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { createNodeNetworkCapture, withoutNetworkCapture } from "@nibi/shared/node";
import type { NetworkCaptureBatch } from "@nibi/shared";
import { createNetworkProxyFetch } from "../src/network/proxy-fetch.js";
import { createMcpTransportFetch } from "../src/mcp/network.js";

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

it("CLI 原有 proxy/noProxy 路由与响应不变，目标只记一条，MCP 直连和代理均排除", async () => {
  const upstream = createServer((_req, res) => res.end("unchanged"));
  const target = await listen(upstream);
  const proxiedTarget = `http://proxied.test:${new URL(target).port}`;
  let forwarded = 0;
  const proxy = createServer((req, res) =>
    withoutNetworkCapture(() => {
      forwarded++;
      // 代理收到的是绝对 URL；回环目标已改为直连，这里用 fake host 并转回本地 upstream。
      const targetUrl = new URL(req.url!);
      const outgoing = request(
        {
          hostname: "127.0.0.1",
          port: targetUrl.port,
          path: `${targetUrl.pathname}${targetUrl.search}`,
          method: req.method,
        },
        (response) => response.pipe(res),
      );
      outgoing.on("error", () => res.destroy());
      req.pipe(outgoing);
    }),
  );
  const httpProxy = await listen(proxy);
  const original = globalThis.fetch;
  const batches: NetworkCaptureBatch[] = [];
  const capture = createNodeNetworkCapture("cli", (batch) => batches.push(batch));
  capture.setCaptureId("cli-proxy");
  try {
    const proxyFetch = createNetworkProxyFetch({ env: {}, httpProxy });
    expect(await (await proxyFetch(`${proxiedTarget}/proxy?key=secret`)).text()).toBe("unchanged");
    expect(forwarded).toBe(1);
    const bypass = createNetworkProxyFetch({ env: {}, httpProxy, noProxy: "127.0.0.1" });
    expect(await (await bypass(`${target}/bypass`)).text()).toBe("unchanged");
    expect(forwarded).toBe(1);
    await (await createMcpTransportFetch({ env: {} })(`${target}/mcp-direct`)).text();
    await (
      await createMcpTransportFetch({ env: {}, network: { httpProxy } })(
        `${proxiedTarget}/mcp-proxy`,
      )
    ).text();
    expect(forwarded).toBe(2);
    await vi.waitFor(() => expect(batches.flatMap((batch) => batch.records)).toHaveLength(2));
    const records = batches.flatMap((batch) => batch.records);
    expect(records.map((record) => record.url)).toEqual([
      `${proxiedTarget}/proxy?key=%5Bredacted%5D`,
      `${target}/bypass`,
    ]);
    expect(globalThis.fetch).toBe(original);
  } finally {
    capture.setCaptureId(null);
    await close(proxy);
    await close(upstream);
  }
});
