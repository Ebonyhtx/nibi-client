import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  addMarketplace,
  installMarketplacePlugin,
  listInstalledPluginRecords,
} from "../src/plugins/index.js";
import {
  resolveHttpZipSource,
  withPaidLicenseHeaderForNibiHosts,
} from "../src/plugins/zip-source.js";
import { createSharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";
import { NIBI_LICENSE_ISSUER } from "@nibi/shared";

const tempDirs: string[] = [];
const servers: Server[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `nibi-license-header-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function listenLoopbackServer(server: Server): Promise<string> {
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("loopback server did not listen on a port");
      }
      resolvePromise(`http://127.0.0.1:${address.port}`);
    });
  });
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolvePromise) => {
          server.close(() => resolvePromise());
        }),
    ),
  );
});

function makeTestLicense(): {
  publicKeys: Record<string, string>;
  token: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const kid = "test-key-1";
  const b64url = (value: Buffer) => value.toString("base64url");
  const header = b64url(Buffer.from(JSON.stringify({ alg: "Ed25519", kid }), "utf8"));
  const payload = b64url(
    Buffer.from(
      JSON.stringify({
        iss: NIBI_LICENSE_ISSUER,
        sub: "user-1",
        uid: "user-1",
        dev: "device-1234",
        plugins: ["*"],
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      "utf8",
    ),
  );
  const signature = edSign(null, Buffer.from(`${header}.${payload}`, "utf8"), privateKey);
  return { publicKeys: { [kid]: publicPem }, token: `${header}.${payload}.${b64url(signature)}` };
}

async function writeEvilMarketplace(input: {
  zipUrl: string;
  marketplaceId: string;
}): Promise<string> {
  const root = await makeTempDir("mp");
  await mkdir(join(root, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(root, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: input.marketplaceId,
      plugins: [
        {
          name: "paid-tool",
          paid: true,
          source: {
            source: "url",
            type: "zip",
            url: input.zipUrl,
            sha256: "a".repeat(64),
          },
        },
      ],
    }),
  );
  return root;
}

describe("paid plugin license header exfiltration guard", () => {
  it("never contacts a third-party zip host for a paid entry and refuses the install", async () => {
    const license = makeTestLicense();
    let requests = 0;
    const evil = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "application/zip" });
      response.end(Buffer.alloc(0));
    });
    servers.push(evil);
    const evilUrl = await listenLoopbackServer(evil);
    const marketplaceRoot = await writeEvilMarketplace({
      marketplaceId: "evil-mp",
      zipUrl: `${evilUrl}/evil.zip`,
    });
    const storageRoot = await makeTempDir("storage");
    const credentialRoot = await makeTempDir("creds");
    const credentialStore = createSharedZCodeCredentialStore({
      env: { NIBI_DATA_BASE_DIR: credentialRoot },
    });
    await credentialStore.saveMany({
      "nibi:license:token": license.token,
      "nibi:device:id": "device-1234",
    });

    await addMarketplace({
      source: { source: "directory", path: marketplaceRoot },
      storageRoot,
    });
    await expect(
      installMarketplacePlugin({
        credentialStore,
        licensePublicKeys: license.publicKeys,
        marketplace: "evil-mp",
        name: "paid-tool",
        storageRoot,
      }),
    ).rejects.toThrow(/官方源/);
    expect(requests).toBe(0);
    expect(listInstalledPluginRecords(storageRoot)).toEqual([]);
  });

  it("attaches X-Nibi-License only for NIBI primary content hosts", () => {
    const token = "license-token";
    expect(
      withPaidLicenseHeaderForNibiHosts({
        headers: { "x-custom": "1" },
        licenseToken: token,
        url: "https://api.nibistudio.top/api/v1/plugins/paid-tool/download",
      }),
    ).toEqual({ "x-custom": "1", "X-Nibi-License": token });
    expect(
      withPaidLicenseHeaderForNibiHosts({
        licenseToken: token,
        url: "https://dl.nibistudio.top/paid/paid-tool.zip",
      }),
    ).toEqual({ "X-Nibi-License": token });
    expect(
      withPaidLicenseHeaderForNibiHosts({
        licenseToken: token,
        url: "https://evil.example.com/paid-tool.zip",
      }),
    ).toBeUndefined();
    expect(
      withPaidLicenseHeaderForNibiHosts({
        licenseToken: token,
        url: "http://127.0.0.1:8080/paid-tool.zip",
      }),
    ).toBeUndefined();
    // 没有凭证时原有 headers 原样透传。
    expect(
      withPaidLicenseHeaderForNibiHosts({
        headers: { "x-custom": "1" },
        url: "https://evil.example.com/paid-tool.zip",
      }),
    ).toEqual({ "x-custom": "1" });
  });

  it("rejects manifest-declared X-Nibi-License headers outright", async () => {
    await expect(
      resolveHttpZipSource({
        headers: { "X-Nibi-License": "stolen-token" },
        sha256: "a".repeat(64),
        url: "https://api.nibistudio.top/api/v1/plugins/paid-tool/download",
      }),
    ).rejects.toThrow(/x-nibi-license/iu);
  });
});
