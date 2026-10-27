import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { createNodeNetworkCapture } from "@nibi/shared/node";
import type { NetworkCaptureBatch } from "@nibi/shared";
import { createHostApiNetworkTransport } from "../src/providers/api/nodeApiNetwork.js";

it("Host 原 dispatcher 的 CONNECT 和 noProxy 均正常，只记录目标 HTTP 一次", async () => {
  const upstream = createServer((_req, res) => res.end("unchanged"));
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const upstreamPort = (upstream.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${upstreamPort}`;
  // 非回环目标：显式代理必须真的走 CONNECT；代理统一把它转到本地 upstream。
  const proxied = `http://proxied.test:${upstreamPort}`;
  const proxy = createServer();
  let tunnels = 0;
  proxy.on("connect", (req, client, head) => {
    tunnels++;
    const socket = connect(upstreamPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.write(head);
      socket.pipe(client);
      client.pipe(socket);
    });
    client.on("error", () => socket.destroy());
    socket.on("error", () => client.destroy());
    client.on("close", () => socket.destroy());
    socket.on("close", () => client.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const httpProxy = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const transport = createHostApiNetworkTransport(async () => ({ httpProxy }));
  const bypass = createHostApiNetworkTransport(async () => ({ httpProxy, noProxy: "127.0.0.1" }));
  const batches: NetworkCaptureBatch[] = [];
  const original = globalThis.fetch;
  const capture = createNodeNetworkCapture("host", (batch) => batches.push(batch));
  capture.setCaptureId("host");
  try {
    expect(await (await transport.fetch(`${proxied}/proxy`)).text()).toBe("unchanged");
    expect(tunnels).toBe(1);
    // 本机回环是隐式直连：即使配了代理也不能进代理（本地网关/面板/MCP）。
    expect(await (await transport.fetch(`${origin}/loopback`)).text()).toBe("unchanged");
    expect(tunnels).toBe(1);
    expect(await (await bypass.fetch(`${origin}/bypass`)).text()).toBe("unchanged");
    expect(tunnels).toBe(1);
    await vi.waitFor(() => expect(batches.flatMap((batch) => batch.records)).toHaveLength(3));
    expect(batches.flatMap((batch) => batch.records).map((record) => record.url)).toEqual([
      `${proxied}/proxy`,
      `${origin}/loopback`,
      `${origin}/bypass`,
    ]);
    expect(globalThis.fetch).toBe(original);
  } finally {
    capture.setCaptureId(null);
    await Promise.all([transport.disposeAndWait(), bypass.disposeAndWait()]);
    proxy.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => proxy.close(() => resolve())),
      new Promise<void>((resolve) => upstream.close(() => resolve())),
    ]);
  }
});
