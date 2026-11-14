#!/usr/bin/env node
// 把 `nibi-rs` 打成远端执行器用的 npm 平台包（`@nibi-studio/cli-<platform>`）。
//
// 规格（Rust 侧的消费方）：
// - `kernel/crates/cli/src/machines/executor_dist/package.rs` 从 tarball 取
//   `package/bin/nibi-rs` 与 `package/build.json`，核对 version / target / sha256；
// - 内核按 `@nibi-studio/cli-<Platform::package_id()>` 向 npm 注册表要包，`dist.integrity`
//   是 tarball 的 sha512（npm pack 生成）。
//
// 这个脚本只负责“产出可发布的 tarball”，不发布。发布由 `.github/workflows/rust-npm-packages.yml`
// 的 `publish` job 走 npm trusted publishing（OIDC，不需要 token）完成；手动补发才需要本机
// `npm publish --access public <tarball>` 加 OTP。规则见 docs/release-process.md。
//
// 用法：
//   node scripts/rust-cli/npm/package.mjs \
//     --binary <path/to/nibi-rs> \
//     --target x86_64-unknown-linux-gnu \
//     --version 4.0.0 \
//     --out <dir>
//
// Android 平台包另需 `--lib <path/to/libnibi.so>`（可再给 `--shared-lib <libc++_shared.so>`），
// build.json 会带 `artifacts` 列表供 NIBI-GO 校验 cdylib 完整性。
//
// 输出一行 JSON：包名、版本、target、tarball 路径、sha256、npm integrity。

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** 已发布的平台（与 `.github/workflows/rust-npm-packages.yml` 的 pack matrix 一一对应；Intel Mac 不发布）。 */
const TARGETS = {
  "x86_64-unknown-linux-gnu": { id: "linux-x64-gnu", os: "linux", cpu: "x64", format: "elf" },
  "aarch64-unknown-linux-gnu": { id: "linux-arm64-gnu", os: "linux", cpu: "arm64", format: "elf" },
  "aarch64-apple-darwin": { id: "darwin-arm64", os: "darwin", cpu: "arm64", format: "macho" },
  // NIBI-GO 的本机内核（Phase C）：Android 只消费 npm 包，不经过内核的 ssh-connect `Platform`。
  "aarch64-linux-android": { id: "android-arm64", os: "android", cpu: "arm64", format: "elf" },
};

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
// Mach-O：32/64 位、小端/大端，以及 universal（fat）头。
const MACHO_MAGICS = [
  Buffer.from([0xce, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xfe, 0xed, 0xfa, 0xce]),
  Buffer.from([0xfe, 0xed, 0xfa, 0xcf]),
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
];

export function packageIdForTarget(target) {
  const platform = TARGETS[target];
  if (!platform) {
    throw new Error(
      `unsupported target ${JSON.stringify(target)}; expected one of: ${Object.keys(TARGETS).join(", ")}`,
    );
  }
  return platform;
}

// 与 Rust `plain_version` 同口径：注册表的 latest 会进本机缓存与远端路径。
export function isValidVersion(version) {
  return (
    typeof version === "string" &&
    /^[0-9]/u.test(version) &&
    /^[0-9A-Za-z.+-]+$/u.test(version) &&
    !version.includes("..")
  );
}

/**
 * provenance 校验要求的仓库地址：npm 会把它与 OIDC 令牌里的仓库比对
 * （`Error verifying sigstore provenance bundle: … "repository.url" is ""`）。
 * 与 `.github/workflows/rust-npm-packages.yml` 的 `Ebonyhtx/nibi-client` 一致。
 */
export const REPOSITORY_URL = "git+https://github.com/Ebonyhtx/nibi-client.git";

export function buildPackageManifest({ target, version, sharedLibrary = false }) {
  const platform = packageIdForTarget(target);
  if (!isValidVersion(version)) {
    throw new Error(`invalid version ${JSON.stringify(version)}`);
  }
  const android = target === "aarch64-linux-android";
  return {
    name: `@nibi-studio/cli-${platform.id}`,
    version,
    description: `NIBI kernel (nibi-rs) for ${platform.os}-${platform.cpu}`,
    license: "Apache-2.0",
    repository: { type: "git", url: REPOSITORY_URL },
    os: [platform.os],
    cpu: [platform.cpu],
    bin: { "nibi-rs": "bin/nibi-rs" },
    files: [
      "bin/nibi-rs",
      "build.json",
      ...(android ? ["lib/libnibi.so"] : []),
      ...(android && sharedLibrary ? ["lib/libc++_shared.so"] : []),
    ],
    publishConfig: { access: "public" },
  };
}

/**
 * `sha256` 仍是 `bin/nibi-rs` 的旧字段（Rust 执行器只读它）。Android 另给 `artifacts`
 * 数组，消费端按 `kind: "cdylib"` 取 `lib/libnibi.so`，校验不过就 fail-closed。
 */
export function buildBuildJson({ target, version, sha256, cdylibSha256, sharedLibrarySha256 }) {
  const artifacts = [
    { kind: "bin", path: "bin/nibi-rs", sha256 },
    ...(cdylibSha256
      ? [{ kind: "cdylib", path: "lib/libnibi.so", sha256: cdylibSha256 }]
      : []),
    ...(sharedLibrarySha256
      ? [{ kind: "shared-library", path: "lib/libc++_shared.so", sha256: sharedLibrarySha256 }]
      : []),
  ];
  return {
    version,
    target,
    sha256,
    ...(artifacts.length > 1 ? { artifacts } : {}),
  };
}

export function assertBinaryMatchesTarget(bytes, target) {
  const platform = packageIdForTarget(target);
  const matches =
    platform.format === "elf"
      ? bytes.subarray(0, 4).equals(ELF_MAGIC)
      : MACHO_MAGICS.some((magic) => bytes.subarray(0, 4).equals(magic));
  if (!matches) {
    throw new Error(
      `binary does not look like a ${platform.format === "elf" ? "Linux ELF" : "Mach-O"} executable; refusing to package it for ${target}`,
    );
  }
}

/**
 * 在临时目录里搭 `package/`，跑 `npm pack`，把 tarball 放到 outDir。
 * 返回 `{ tarball, sha256, integrity, size }`。
 */
export async function packPlatformPackage({
  binaryPath,
  target,
  version,
  outDir,
  libraryPath,
  sharedLibraryPath,
}) {
  const platform = packageIdForTarget(target);
  const android = target === "aarch64-linux-android";
  if (android && !libraryPath) {
    throw new Error("android platform package requires --lib (lib/libnibi.so)");
  }
  if (!android && (libraryPath || sharedLibraryPath)) {
    throw new Error("only the android platform package carries shared libraries");
  }
  const sharedLibrary = Boolean(sharedLibraryPath);
  const manifest = buildPackageManifest({ target, version, sharedLibrary });
  const bytes = await readFile(binaryPath);
  assertBinaryMatchesTarget(bytes, target);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const cdylibBytes = libraryPath ? await readFile(libraryPath) : undefined;
  if (cdylibBytes) assertBinaryMatchesTarget(cdylibBytes, target);
  const cdylibSha256 = cdylibBytes
    ? createHash("sha256").update(cdylibBytes).digest("hex")
    : undefined;
  const sharedLibraryBytes = sharedLibraryPath ? await readFile(sharedLibraryPath) : undefined;
  if (sharedLibraryBytes) assertBinaryMatchesTarget(sharedLibraryBytes, target);
  const sharedLibrarySha256 = sharedLibraryBytes
    ? createHash("sha256").update(sharedLibraryBytes).digest("hex")
    : undefined;

  await mkdir(outDir, { recursive: true });
  const stageRoot = await mkdtemp(join(tmpdir(), `nibi-cli-npm-${platform.id}-`));
  const packageDir = join(stageRoot, "package");
  try {
    await mkdir(join(packageDir, "bin"), { recursive: true });
    await copyFile(binaryPath, join(packageDir, "bin", "nibi-rs"));
    await chmod(join(packageDir, "bin", "nibi-rs"), 0o755);
    if (cdylibBytes) {
      await mkdir(join(packageDir, "lib"), { recursive: true });
      await writeFile(join(packageDir, "lib", "libnibi.so"), cdylibBytes);
    }
    if (sharedLibraryBytes) {
      await mkdir(join(packageDir, "lib"), { recursive: true });
      await writeFile(join(packageDir, "lib", "libc++_shared.so"), sharedLibraryBytes);
    }
    await writeFile(
      join(packageDir, "build.json"),
      `${JSON.stringify(buildBuildJson({ target, version, sha256, cdylibSha256, sharedLibrarySha256 }), null, 2)}\n`,
    );
    await writeFile(join(packageDir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--pack-destination", resolve(outDir)], {
        // npm pack 以 cwd 为包根，并自动把内容放进 tarball 的 `package/`。
        cwd: packageDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
        shell: process.platform === "win32",
      }),
    );
    const entry = Array.isArray(packed) ? packed[0] : undefined;
    if (!entry?.filename) {
      throw new Error("npm pack did not report a tarball filename");
    }
    const tarball = resolve(outDir, entry.filename);
    return {
      name: manifest.name,
      version,
      target,
      tarball,
      sha256,
      ...(cdylibSha256 ? { cdylibSha256 } : {}),
      ...(sharedLibrarySha256 ? { sharedLibrarySha256 } : {}),
      integrity: entry.integrity,
      size: entry.size,
    };
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith("--")) throw new Error(`unexpected argument ${JSON.stringify(flag)}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    args[flag.slice(2)] = value;
    index += 1;
  }
  for (const required of ["binary", "target", "version", "out"]) {
    if (!args[required]) throw new Error(`missing --${required}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await packPlatformPackage({
    binaryPath: resolve(args.binary),
    target: args.target,
    version: args.version,
    outDir: resolve(args.out),
    ...(args.lib ? { libraryPath: resolve(args.lib) } : {}),
    ...(args["shared-lib"] ? { sharedLibraryPath: resolve(args["shared-lib"]) } : {}),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[nibi-npm-package] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

export { TARGETS };
