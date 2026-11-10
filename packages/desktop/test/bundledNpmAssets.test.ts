import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUNDLED_NPM_STAGE_MARKER,
  BUNDLED_NPM_STAGED_SEGMENTS,
  bundledNpmTarballUrl,
  readBundledNpmStageMarker,
  resolveLocalNodeNpmRoot,
  stageBundledNpm,
} from "../scripts/bundled-npm-assets.mjs";

const tempRoots: string[] = [];

async function makeTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  vi.restoreAllMocks();
});

type Archive = { bytes: Buffer };

async function writeFakeArchive(path: string): Promise<Archive> {
  const bytes = Buffer.from("fake npm tarball");
  await writeFile(path, bytes);
  return { bytes };
}

function integrityOf(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** 模拟 tar 解包：从归档路径读出 package 条目，在 extractDir 下创建 npm 目录树。 */
async function fakeExtract({
  archivePath,
  extractDir,
}: {
  archivePath: string;
  extractDir: string;
}) {
  const marker = await readFile(archivePath, "utf8");
  const packageRoot = join(extractDir, "package");
  await mkdir(join(packageRoot, "bin"), { recursive: true });
  await writeFile(join(packageRoot, "bin", "npm-cli.js"), `# npm ${marker}\n`);
  await writeFile(join(packageRoot, "bin", "npx-cli.js"), `# npx ${marker}\n`);
  await writeFile(join(packageRoot, "package.json"), '{"name":"npm"}\n');
  await mkdir(join(packageRoot, "docs"), { recursive: true });
  await writeFile(join(packageRoot, "docs", "readme.md"), "docs\n");
  await mkdir(join(packageRoot, "man"), { recursive: true });
  await writeFile(join(packageRoot, "man", "npm.1"), "man\n");
  await mkdir(join(packageRoot, "node_modules", "dep"), { recursive: true });
  await writeFile(join(packageRoot, "node_modules", "dep", "LICENSE"), "license\n");
}

async function writeLocalNpm(root: string): Promise<string> {
  const npmRoot = join(root, "local-npm");
  await mkdir(join(npmRoot, "bin"), { recursive: true });
  await writeFile(join(npmRoot, "bin", "npm-cli.js"), "");
  await writeFile(join(npmRoot, "bin", "npx-cli.js"), "");
  await writeFile(join(npmRoot, "package.json"), '{"name":"local-npm"}\n');
  return npmRoot;
}

function createDownload(archive: Archive) {
  return vi.fn(async (_url: string, destinationPath: string) => {
    await writeFile(destinationPath, archive.bytes);
  });
}

describe("stageBundledNpm", () => {
  it("verifies the registry tarball and copies it into node-runtime/npm without docs/man", async () => {
    const root = await makeTempRoot("nibi-bundled-npm-");
    const cacheDir = join(root, "cache");
    const glmDir = join(root, "glm");
    const download = vi.fn(async (_url: string, destinationPath: string) => {
      await writeFakeArchive(destinationPath);
    });

    const result = await stageBundledNpm({
      cacheDir,
      download,
      extract: fakeExtract,
      glmDir,
      integrity: integrityOf(Buffer.from("fake npm tarball")),
      version: "1.2.3",
    });

    const stagedRoot = join(glmDir, ...BUNDLED_NPM_STAGED_SEGMENTS);
    expect(result).toEqual({
      integrityVerified: true,
      source: "registry",
      stagedRoot,
      version: "1.2.3",
    });
    expect(download).toHaveBeenCalledWith(bundledNpmTarballUrl("1.2.3"), expect.any(String));
    expect(existsSync(join(stagedRoot, "bin", "npm-cli.js"))).toBe(true);
    expect(existsSync(join(stagedRoot, "bin", "npx-cli.js"))).toBe(true);
    expect(existsSync(join(stagedRoot, "docs"))).toBe(false);
    expect(existsSync(join(stagedRoot, "man"))).toBe(false);
    // 依赖包自己的 license 必须留在 staged 树里。
    expect(existsSync(join(stagedRoot, "node_modules", "dep", "LICENSE"))).toBe(true);
    expect(await readBundledNpmStageMarker(glmDir)).toMatchObject({
      integrityVerified: true,
      source: "registry",
      version: "1.2.3",
    });
    expect(existsSync(join(cacheDir, "npm-1.2.3.tgz"))).toBe(true);
  });

  it("reuses a valid cached tarball and replaces a corrupt one", async () => {
    const root = await makeTempRoot("nibi-bundled-npm-");
    const cacheDir = join(root, "cache");
    const glmDir = join(root, "glm");
    const archive = { bytes: Buffer.from("fake npm tarball") };
    const integrity = integrityOf(archive.bytes);
    const download = createDownload(archive);

    await stageBundledNpm({
      cacheDir,
      download,
      extract: fakeExtract,
      glmDir,
      integrity,
      version: "1.2.3",
    });
    expect(download).toHaveBeenCalledTimes(1);

    await stageBundledNpm({
      cacheDir,
      download,
      extract: fakeExtract,
      glmDir,
      integrity,
      version: "1.2.3",
    });
    expect(download).toHaveBeenCalledTimes(1);

    await writeFile(join(cacheDir, "npm-1.2.3.tgz"), "corrupted");
    await stageBundledNpm({
      cacheDir,
      download,
      extract: fakeExtract,
      glmDir,
      integrity,
      version: "1.2.3",
    });
    expect(download).toHaveBeenCalledTimes(2);
    expect((await stat(join(cacheDir, "npm-1.2.3.tgz"))).size).toBe(archive.bytes.length);
  });

  it("rejects a tarball whose sha512 does not match", async () => {
    const root = await makeTempRoot("nibi-bundled-npm-");
    const archive = { bytes: Buffer.from("tampered") };
    const download = createDownload(archive);

    await expect(
      stageBundledNpm({
        allowLocalFallback: false,
        cacheDir: join(root, "cache"),
        download,
        extract: fakeExtract,
        glmDir: join(root, "glm"),
        integrity: integrityOf(Buffer.from("expected")),
        version: "1.2.3",
      }),
    ).rejects.toThrow(/sha512 mismatch/);
    expect(existsSync(join(root, "glm", ...BUNDLED_NPM_STAGED_SEGMENTS))).toBe(false);
  });

  it("fails when the extracted npm has no entry files", async () => {
    const root = await makeTempRoot("nibi-bundled-npm-");
    const archive = { bytes: Buffer.from("empty package") };

    await expect(
      stageBundledNpm({
        allowLocalFallback: false,
        cacheDir: join(root, "cache"),
        download: createDownload(archive),
        extract: async ({ extractDir }: { extractDir: string }) => {
          await mkdir(join(extractDir, "package"), { recursive: true });
        },
        glmDir: join(root, "glm"),
        integrity: integrityOf(archive.bytes),
        version: "1.2.3",
      }),
    ).rejects.toThrow(/missing npm entry/);
  });

  it("falls back to the local Node npm when the registry is unreachable", async () => {
    const root = await makeTempRoot("nibi-bundled-npm-");
    const localNpmRoot = await writeLocalNpm(root);
    const logs: string[] = [];

    const result = await stageBundledNpm({
      cacheDir: join(root, "cache"),
      download: async () => {
        throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
      },
      extract: fakeExtract,
      glmDir: join(root, "glm"),
      localNpmRoot,
      log: (line: string) => logs.push(line),
      version: "1.2.3",
    });

    expect(result.source).toBe("local-node");
    expect(result.integrityVerified).toBe(false);
    expect(await readBundledNpmStageMarker(join(root, "glm"))).toMatchObject({
      integrityVerified: false,
      source: "local-node",
    });
    expect(logs.join("\n")).toMatch(/sha512 was NOT verified/);
    expect(existsSync(join(root, "glm", ...BUNDLED_NPM_STAGED_SEGMENTS, "bin", "npm-cli.js"))).toBe(
      true,
    );
  });

  it("fails instead of falling back when local fallback is disabled or no local npm exists", async () => {
    const root = await makeTempRoot("nibi-bundled-npm-");
    const download = async () => {
      throw new Error("network down");
    };

    await expect(
      stageBundledNpm({
        allowLocalFallback: false,
        cacheDir: join(root, "cache"),
        download,
        extract: fakeExtract,
        glmDir: join(root, "glm"),
        localNpmRoot: await writeLocalNpm(root),
        version: "1.2.3",
      }),
    ).rejects.toThrow(/network down/);

    await expect(
      stageBundledNpm({
        cacheDir: join(root, "cache"),
        download,
        extract: fakeExtract,
        glmDir: join(root, "glm"),
        localNpmRoot: join(root, "missing"),
        version: "1.2.3",
      }),
    ).rejects.toThrow(/no usable local Node npm/);
  });

  it("skips the network entirely in offline mode and marks the marker unverified", async () => {
    const root = await makeTempRoot("nibi-bundled-npm-");
    const localNpmRoot = await writeLocalNpm(root);
    const download = vi.fn();

    const result = await stageBundledNpm({
      cacheDir: join(root, "cache"),
      download,
      extract: fakeExtract,
      glmDir: join(root, "glm"),
      localNpmRoot,
      offline: true,
      version: "1.2.3",
    });

    expect(download).not.toHaveBeenCalled();
    expect(result.source).toBe("local-node");
    expect(result.integrityVerified).toBe(false);
    const marker = JSON.parse(
      await readFile(join(root, "glm", BUNDLED_NPM_STAGE_MARKER), "utf8"),
    ) as { source: string };
    expect(marker.source).toBe("local-node");
  });
});

describe("resolveLocalNodeNpmRoot", () => {
  it("finds the npm package next to the running Node executable", () => {
    const nodeDir = join(process.execPath, "..");
    const candidates = [
      join(nodeDir, "..", "lib", "node_modules", "npm"),
      join(nodeDir, "node_modules", "npm"),
    ];
    const expected = candidates.find((candidate) =>
      existsSync(join(candidate, "bin", "npm-cli.js")),
    );

    expect(resolveLocalNodeNpmRoot()).toBe(expected);
  });
});
