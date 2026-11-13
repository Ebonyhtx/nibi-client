import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bundledNpmRootCandidates,
  resolveMcpNodeFallbackProvider,
} from "../src/app/mcpNodeFallback/index.js";

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function writeBundledNpm(root: string): Promise<string> {
  const npmRoot = join(root, "node-runtime", "npm");
  await mkdir(join(npmRoot, "bin"), { recursive: true });
  await writeFile(join(npmRoot, "bin", "npm-cli.js"), "");
  await writeFile(join(npmRoot, "bin", "npx-cli.js"), "");
  return npmRoot;
}

describe("resolveMcpNodeFallbackProvider", () => {
  it("does not create a provider outside the Electron Node runtime", () => {
    expect(
      resolveMcpNodeFallbackProvider({
        cliStorageRoot: "/tmp/nibi/cli",
        runtime: {
          baseDirs: ["/opt/nibi/glm"],
          electronVersion: undefined,
          execPath: "/usr/bin/node",
        },
      }),
    ).toBeUndefined();
  });

  it("prepares the shim directory under the CLI storage root on Electron", async () => {
    const root = await makeTempRoot("nibi-bootstrap-node-fallback-");
    const npmRoot = await writeBundledNpm(root);
    const provider = resolveMcpNodeFallbackProvider({
      cliStorageRoot: join(root, "cli"),
      runtime: {
        baseDirs: [root, join(root, "missing")],
        electronVersion: "44.10.1",
        execPath: join(root, "NIBI"),
      },
    });

    expect(provider).toBeDefined();
    const fallback = await provider!.resolve();

    expect(fallback).toEqual({
      binDir: join(root, "cli", "node-fallback", "v1"),
      env: {
        NIBI_NODE_FALLBACK_EXEC_PATH: join(root, "NIBI"),
        NIBI_NODE_FALLBACK_NPM_ROOT: npmRoot,
      },
    });
    const shim = await readFile(
      join(fallback!.binDir, process.platform === "win32" ? "node.cmd" : "node"),
      "utf8",
    );
    expect(shim).toContain("ELECTRON_RUN_AS_NODE=1");
  });

  it("omits the npm root when the bundle has no staged npm", async () => {
    const root = await makeTempRoot("nibi-bootstrap-node-fallback-");
    const provider = resolveMcpNodeFallbackProvider({
      cliStorageRoot: join(root, "cli"),
      runtime: {
        baseDirs: [root],
        electronVersion: "44.10.1",
        execPath: join(root, "NIBI"),
      },
    });

    await expect(provider!.resolve()).resolves.toEqual({
      binDir: join(root, "cli", "node-fallback", "v1"),
      env: {
        NIBI_NODE_FALLBACK_EXEC_PATH: join(root, "NIBI"),
      },
    });
  });
});

describe("bundledNpmRootCandidates", () => {
  it("maps every base dir onto node-runtime/npm and de-duplicates", () => {
    expect(
      bundledNpmRootCandidates(["/opt/nibi/glm", "/opt/nibi/glm", "/opt/nibi/resources/nibi"]),
    ).toEqual([
      join("/opt/nibi/glm", "node-runtime", "npm"),
      join("/opt/nibi/resources/nibi", "node-runtime", "npm"),
    ]);
  });

  it("uses only the bundle dirs it was given (no workspace cwd candidate)", () => {
    expect(bundledNpmRootCandidates(["/opt/nibi/glm"])).toEqual([
      join("/opt/nibi/glm", "node-runtime", "npm"),
    ]);
  });
});
