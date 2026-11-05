import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  buildBuildJson,
  buildPackageManifest,
  isValidVersion,
  packageIdForTarget,
  packPlatformPackage,
} from "./package.mjs";

let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "nibi-npm-package-test-"));
});

after(async () => {
  await rm(root, { force: true, recursive: true });
});

/**
 * Node 在 Windows 上会先找到 Git/MSYS 的 GNU tar：它把 `C:/...` 当远程主机
 * （`tar (child): Cannot connect to C: resolve failed`）。用系统自带的 bsdtar。
 */
function systemTar() {
  if (process.platform !== "win32") return "tar";
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
}

function fakeElf() {
  // ELF 头 + 几字节正文：脚本只校验头，Rust 侧的 extract 才做完整核对。
  return Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01]), Buffer.from("nibi")]);
}

test("maps the published targets and refuses Intel Mac", () => {
  assert.equal(packageIdForTarget("x86_64-unknown-linux-gnu").id, "linux-x64-gnu");
  assert.equal(packageIdForTarget("aarch64-unknown-linux-gnu").id, "linux-arm64-gnu");
  assert.equal(packageIdForTarget("aarch64-apple-darwin").id, "darwin-arm64");
  assert.throws(() => packageIdForTarget("x86_64-apple-darwin"), /unsupported target/u);
});

test("builds the manifest and build.json the kernel expects", () => {
  const manifest = buildPackageManifest({ target: "x86_64-unknown-linux-gnu", version: "4.0.0" });
  assert.equal(manifest.name, "@nibi/cli-linux-x64-gnu");
  assert.deepEqual(manifest.os, ["linux"]);
  assert.deepEqual(manifest.cpu, ["x64"]);
  assert.deepEqual(manifest.files, ["bin/nibi-rs", "build.json"]);
  assert.deepEqual(buildBuildJson({ target: "aarch64-apple-darwin", version: "4.0.0", sha256: "a".repeat(64) }), {
    version: "4.0.0",
    target: "aarch64-apple-darwin",
    sha256: "a".repeat(64),
  });
  assert.equal(isValidVersion("4.0.0-beta.1"), true);
  assert.equal(isValidVersion("v4.0.0"), false);
  assert.equal(isValidVersion("4..0"), false);
  assert.throws(() => buildPackageManifest({ target: "x86_64-unknown-linux-gnu", version: "v4" }), /invalid version/u);
});

test("packs package/bin/nibi-rs and package/build.json with the real sha256", async () => {
  const binaryPath = join(root, "nibi-rs");
  await writeFile(binaryPath, fakeElf());
  const outDir = join(root, "out");
  const result = await packPlatformPackage({
    binaryPath,
    target: "x86_64-unknown-linux-gnu",
    version: "4.0.0",
    outDir,
  });
  assert.equal(result.name, "@nibi/cli-linux-x64-gnu");
  assert.match(result.integrity, /^sha512-/u);
  assert.equal(result.sha256, createHash("sha256").update(fakeElf()).digest("hex"));

  const extractDir = join(root, "extract");
  await mkdir(extractDir, { recursive: true });
  execFileSync(systemTar(), ["-xzf", result.tarball], { cwd: extractDir, stdio: "inherit" });
  const manifest = JSON.parse(await readFile(join(extractDir, "package", "package.json"), "utf8"));
  assert.equal(manifest.name, "@nibi/cli-linux-x64-gnu");
  assert.equal(manifest.version, "4.0.0");
  const build = JSON.parse(await readFile(join(extractDir, "package", "build.json"), "utf8"));
  assert.deepEqual(build, {
    version: "4.0.0",
    target: "x86_64-unknown-linux-gnu",
    sha256: result.sha256,
  });
  assert.deepEqual(await readFile(join(extractDir, "package", "bin", "nibi-rs")), fakeElf());
});

test("refuses a binary whose header does not match the target", async () => {
  const macho = join(root, "nibi-macho");
  await writeFile(macho, Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from("nibi")]));
  await assert.rejects(
    packPlatformPackage({
      binaryPath: macho,
      target: "x86_64-unknown-linux-gnu",
      version: "4.0.0",
      outDir: join(root, "out2"),
    }),
    /does not look like a Linux ELF/u,
  );
});
