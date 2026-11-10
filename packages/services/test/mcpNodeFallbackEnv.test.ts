import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMcpNodeFallbackHostEnv,
  ensureMcpNodeFallbackShimDir,
  fallbackPathPatch,
  MCP_NODE_FALLBACK_EXEC_PATH_ENV_KEY,
  MCP_NODE_FALLBACK_NPM_ROOT_ENV_KEY,
  renderMcpNodeFallbackShims,
} from "../src/zcode-agent/mcpNodeFallback/index.js";

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function writeFakeNpmPackage(root: string): Promise<string> {
  const npmRoot = join(root, "npm");
  await mkdir(join(npmRoot, "bin"), { recursive: true });
  await writeFile(join(npmRoot, "bin", "npm-cli.js"), "");
  await writeFile(join(npmRoot, "bin", "npx-cli.js"), "");
  return npmRoot;
}

describe("buildMcpNodeFallbackHostEnv", () => {
  it("is a no-op for the Node kernel", async () => {
    const root = await makeTempRoot("nibi-host-node-fallback-");

    await expect(
      buildMcpNodeFallbackHostEnv({
        execPath: "/opt/nibi/electron",
        isElectron: true,
        kernel: "node",
        storageRoot: root,
      }),
    ).resolves.toEqual({});
  });

  it("is a no-op outside the desktop Electron runtime (remote Host)", async () => {
    const root = await makeTempRoot("nibi-host-node-fallback-");

    await expect(
      buildMcpNodeFallbackHostEnv({
        execPath: "/usr/bin/node",
        isElectron: false,
        kernel: "rust",
        storageRoot: root,
      }),
    ).resolves.toEqual({});
  });

  it("appends the shim dir to PATH and publishes the exec path and bundled npm", async () => {
    const root = await makeTempRoot("nibi-host-node-fallback-");
    const npmRoot = await writeFakeNpmPackage(root);

    const env = await buildMcpNodeFallbackHostEnv({
      execPath: "/opt/nibi/electron",
      isElectron: true,
      kernel: "rust",
      npmRootCandidates: [join(root, "missing"), npmRoot],
      platform: "linux",
      processEnv: { PATH: "/usr/bin:/bin" },
      storageRoot: root,
    });

    const binDir = join(root, "node-fallback", "v1");
    expect(env).toEqual({
      [MCP_NODE_FALLBACK_EXEC_PATH_ENV_KEY]: "/opt/nibi/electron",
      [MCP_NODE_FALLBACK_NPM_ROOT_ENV_KEY]: npmRoot,
      PATH: `/usr/bin:/bin:${binDir}`,
    });
    for (const shim of renderMcpNodeFallbackShims("linux")) {
      expect(await readFile(join(binDir, shim.name), "utf8")).toBe(shim.content);
    }
  });

  it("keeps the user's own node/npm/npx first (shim dir is the last PATH entry)", async () => {
    const root = await makeTempRoot("nibi-host-node-fallback-");

    const env = await buildMcpNodeFallbackHostEnv({
      execPath: "/opt/nibi/electron",
      isElectron: true,
      kernel: "rust",
      npmRootCandidates: [],
      platform: "darwin",
      processEnv: { PATH: "/Users/dev/.nvm/versions/node/v24/bin:/usr/bin" },
      storageRoot: root,
    });

    expect(env.PATH).toBe(
      `/Users/dev/.nvm/versions/node/v24/bin:/usr/bin:${join(root, "node-fallback", "v1")}`,
    );
    expect(env[MCP_NODE_FALLBACK_NPM_ROOT_ENV_KEY]).toBeUndefined();
  });

  it("writes exactly one uppercase PATH key on Windows", async () => {
    const root = await makeTempRoot("nibi-host-node-fallback-");

    const env = await buildMcpNodeFallbackHostEnv({
      execPath: "C:\\Program Files\\NIBI\\NIBI.exe",
      isElectron: true,
      kernel: "rust",
      npmRootCandidates: [],
      platform: "win32",
      processEnv: { Path: "C:\\Windows\\System32" },
      storageRoot: root,
    });

    expect(env).toEqual({
      [MCP_NODE_FALLBACK_EXEC_PATH_ENV_KEY]: "C:\\Program Files\\NIBI\\NIBI.exe",
      Path: undefined,
      PATH: `C:\\Windows\\System32;${join(root, "node-fallback", "v1")}`,
    });
  });

  it("degrades to an empty patch when the shim directory cannot be written", async () => {
    const root = await makeTempRoot("nibi-host-node-fallback-");
    const blockedStorageRoot = join(root, "file");
    await writeFile(blockedStorageRoot, "");

    await expect(
      buildMcpNodeFallbackHostEnv({
        execPath: "/opt/nibi/electron",
        isElectron: true,
        kernel: "rust",
        npmRootCandidates: [],
        platform: "linux",
        storageRoot: blockedStorageRoot,
      }),
    ).resolves.toEqual({});
  });
});

describe("ensureMcpNodeFallbackShimDir", () => {
  it("does not rewrite identical shims", async () => {
    const binDir = join(await makeTempRoot("nibi-host-node-fallback-"), "bin");

    await ensureMcpNodeFallbackShimDir(binDir, process.platform);
    const shims = renderMcpNodeFallbackShims(process.platform);
    const firstStats = await Promise.all(shims.map((shim) => stat(join(binDir, shim.name))));
    await ensureMcpNodeFallbackShimDir(binDir, process.platform);
    const secondStats = await Promise.all(shims.map((shim) => stat(join(binDir, shim.name))));

    for (const [index] of shims.entries()) {
      expect(secondStats[index]!.mtimeMs).toBe(firstStats[index]!.mtimeMs);
    }
  });

  it("repairs changed content", async () => {
    const binDir = join(await makeTempRoot("nibi-host-node-fallback-"), "bin");
    await ensureMcpNodeFallbackShimDir(binDir, process.platform);
    const [firstShim] = renderMcpNodeFallbackShims(process.platform);
    await writeFile(join(binDir, firstShim!.name), "corrupted");

    await ensureMcpNodeFallbackShimDir(binDir, process.platform);

    expect(await readFile(join(binDir, firstShim!.name), "utf8")).toBe(firstShim!.content);
  });
});

describe("fallbackPathPatch", () => {
  it("does not append the shim dir twice", () => {
    expect(fallbackPathPatch("/usr/bin:/shim/v1", "/shim/v1", "linux")).toEqual({});
    expect(fallbackPathPatch("/usr/bin", "/usr/bin/", "darwin")).toEqual({});
  });

  it("uses the shim dir when PATH is empty", () => {
    expect(fallbackPathPatch("", "/shim/v1", "linux")).toEqual({ PATH: "/shim/v1" });
  });
});
