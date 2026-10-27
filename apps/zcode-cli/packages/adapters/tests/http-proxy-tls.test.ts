import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net, { type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeWebFetchHttpClientAdapter } from "../src/http/index.js";

/**
 * 回归：经 HTTP CONNECT 代理访问 HTTPS 时，必须把目标主机名作为 servername 交给
 * TLS 层。https-proxy-agent 在升级 TLS 前会丢掉 host；不显式传 servername 时 Node
 * 退到默认 "localhost"，会让所有代理链路上的证书名校验失败
 * （线上实测：镜像主机的证书报 `Host: localhost ... IP:203.0.113.10`）。
 */

const FIXTURES = join(import.meta.dirname, "fixtures", "proxy-tls");
const CA_PEM = readFileSync(join(FIXTURES, "ca.pem"), "utf8");
const LEAF_PEM = readFileSync(join(FIXTURES, "leaf.pem"), "utf8");
const LEAF_KEY = readFileSync(join(FIXTURES, "leaf-key.pem"), "utf8");

const cleanups: Array<() => Promise<void>> = [];
const sockets = new Set<net.Socket>();

function trackSockets(server: net.Server): void {
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  return (server.address() as AddressInfo).port;
}

function startTlsUpstream(): { port: Promise<number>; sni: string[] } {
  const sni: string[] = [];
  const server = https.createServer({ cert: LEAF_PEM, key: LEAF_KEY }, (_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ok");
  });
  server.on("secureConnection", (socket) => {
    if (socket.servername) sni.push(socket.servername);
  });
  trackSockets(server);
  const port = listen(server);
  cleanups.push(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  });
  return { port, sni };
}

function startConnectProxy(): Promise<number> {
  const server = http.createServer((_request, response) => {
    response.writeHead(405);
    response.end();
  });
  server.on("connect", (request, clientSocket, head) => {
    const [, requestedPort] = (request.url ?? "").split(":");
    // 测试里 content.test 不解析，统一落到本机；真实代理会按目标主机转发。
    const target = net.connect(Number(requestedPort), "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) target.write(head);
      target.pipe(clientSocket);
      clientSocket.pipe(target);
    });
    target.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => target.destroy());
  });
  trackSockets(server);
  const port = listen(server);
  cleanups.push(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  });
  return port;
}

function createAdapter(proxyPort: number) {
  return createNodeWebFetchHttpClientAdapter({
    caCertPem: CA_PEM,
    env: {},
    maxResponseBytes: 1024 * 1024,
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    timeoutMs: 10_000,
  });
}

describe("HTTP adapter over CONNECT proxy", () => {
  it("validates a DNS host against its certificate and sends SNI", async () => {
    const upstream = startTlsUpstream();
    const proxyPort = await startConnectProxy();
    const response = await createAdapter(proxyPort).request({
      method: "GET",
      url: `https://content.test:${await upstream.port}/probe`,
    });

    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.body)).toBe("ok");
    expect(upstream.sni).toContain("content.test");
  });

  it("validates an IP target instead of falling back to localhost", async () => {
    const upstream = startTlsUpstream();
    const proxyPort = await startConnectProxy();
    const response = await createAdapter(proxyPort).request({
      method: "GET",
      url: `https://127.0.0.1:${await upstream.port}/probe`,
    });

    expect(response.status).toBe(200);
    expect(new TextDecoder().decode(response.body)).toBe("ok");
  });

  it("still rejects a certificate that does not cover the target host", async () => {
    const upstream = startTlsUpstream();
    const proxyPort = await startConnectProxy();
    await expect(
      createAdapter(proxyPort).request({
        method: "GET",
        url: `https://other.test:${await upstream.port}/probe`,
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^(network|proxy)_error$/u) });
  });
});
