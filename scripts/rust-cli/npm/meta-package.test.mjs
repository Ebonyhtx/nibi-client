import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  FORWARDED_SIGNALS,
  META_PACKAGE_NAME,
  PLATFORM_PACKAGES,
  detectManagerMarker,
  forwardSignals,
  managedEnvironment,
  platformPackageName,
  resolvePlatformBinary,
  runLauncher,
} from "./bin/launcher.mjs";
import { buildMetaPackageManifest, metaPackageDependencies, packMetaPackage } from "./meta-package.mjs";
import { TARGETS } from "./package.mjs";

const execFileAsync = promisify(execFile);
const launcherDirectory = join(import.meta.dirname, "bin");

let root;
let resolveFixture;
let resolveRequireFrom;

/**
 * Node 在 Windows 上会先找到 Git/MSYS 的 GNU tar：它把 `C:/...` 当远程主机
 * （`tar (child): Cannot connect to C: resolve failed`）。用系统自带的 bsdtar。
 */
function systemTar() {
  if (process.platform !== "win32") return "tar";
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
}

async function writeFakePlatformPackage({ appDirectory, packageName, executable }) {
  const packageDirectory = join(appDirectory, "node_modules", ...packageName.split("/"));
  await mkdir(join(packageDirectory, "bin"), { recursive: true });
  await writeFile(
    join(packageDirectory, "package.json"),
    `${JSON.stringify({ name: packageName, version: "0.0.0" }, null, 2)}\n`,
  );
  const binaryPath = join(packageDirectory, "bin", "nibi-rs");
  await writeFile(binaryPath, executable);
  if (process.platform !== "win32") await chmod(binaryPath, 0o755);
  return binaryPath;
}

async function stageLauncher(appDirectory) {
  await mkdir(join(appDirectory, "bin"), { recursive: true });
  await copyFile(join(launcherDirectory, "nibi.js"), join(appDirectory, "bin", "nibi.js"));
  await copyFile(join(launcherDirectory, "launcher.mjs"), join(appDirectory, "bin", "launcher.mjs"));
  await writeFile(join(appDirectory, "package.json"), '{"type":"module"}\n');
  return join(appDirectory, "bin", "nibi.js");
}

function fakeSpawn() {
  const record = { call: undefined, child: undefined };
  const child = new EventEmitter();
  child.kill = (signal) => {
    record.signal = signal;
    return true;
  };
  record.child = child;
  const spawnImpl = (command, args, options) => {
    record.call = { command, args, options };
    return child;
  };
  return { record, spawnImpl };
}

function fakeStdio() {
  return {
    text: "",
    write(chunk) {
      this.text += chunk;
    },
  };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "nibi-meta-package-test-"));

  resolveFixture = join(root, "resolve");
  await mkdir(resolveFixture, { recursive: true });
  await writeFile(join(resolveFixture, "package.json"), "{}\n");
  resolveRequireFrom = pathToFileURL(join(resolveFixture, "package.json")).href;
  await writeFakePlatformPackage({
    appDirectory: resolveFixture,
    packageName: "@nibi-studio/cli-linux-x64-gnu",
    executable: Buffer.from("fake-binary"),
  });
});

after(async () => {
  await rm(root, { force: true, recursive: true });
});

test("the launcher maps exactly the four published platform packages", () => {
  assert.deepEqual(Object.keys(PLATFORM_PACKAGES), [
    "linux-x64",
    "linux-arm64",
    "darwin-arm64",
    "android-arm64",
  ]);
  // 平台包清单与 package.mjs 的 TARGETS 是同一份发布矩阵；新增 target 时两边一起改。
  assert.deepEqual(
    Object.values(PLATFORM_PACKAGES).sort(),
    Object.values(TARGETS)
      .map((platform) => `@nibi-studio/cli-${platform.id}`)
      .sort(),
  );
  assert.equal(platformPackageName({ platform: "linux", arch: "x64" }), "@nibi-studio/cli-linux-x64-gnu");
  assert.equal(platformPackageName({ platform: "linux", arch: "arm64" }), "@nibi-studio/cli-linux-arm64-gnu");
  assert.equal(platformPackageName({ platform: "darwin", arch: "arm64" }), "@nibi-studio/cli-darwin-arm64");
  assert.equal(platformPackageName({ platform: "android", arch: "arm64" }), "@nibi-studio/cli-android-arm64");
});

test("unsupported platforms fail closed with the supported list", () => {
  for (const platform of [
    { platform: "win32", arch: "x64" },
    { platform: "darwin", arch: "x64" },
    { platform: "linux", arch: "s390x" },
  ]) {
    assert.throws(
      () => platformPackageName(platform),
      /unsupported platform .*; supported platforms: linux-x64, linux-arm64, darwin-arm64, android-arm64/u,
    );
  }
});

test("the META manifest pins exact platform versions and exposes only the nibi bin", () => {
  const manifest = buildMetaPackageManifest({ version: "4.2.0" });
  assert.equal(manifest.name, META_PACKAGE_NAME);
  assert.equal(manifest.name, "@nibi-studio/cli");
  assert.equal(manifest.version, "4.2.0");
  assert.deepEqual(manifest.bin, { nibi: "bin/nibi.js" });
  assert.deepEqual(manifest.files, ["bin/nibi.js", "bin/launcher.mjs", "README.md", "LICENSE"]);
  assert.deepEqual(manifest.optionalDependencies, {
    "@nibi-studio/cli-linux-x64-gnu": "4.2.0",
    "@nibi-studio/cli-linux-arm64-gnu": "4.2.0",
    "@nibi-studio/cli-darwin-arm64": "4.2.0",
    "@nibi-studio/cli-android-arm64": "4.2.0",
  });
  for (const version of Object.values(manifest.optionalDependencies)) {
    assert.doesNotMatch(version, /[\^~*x]/u);
  }
  assert.equal(manifest.repository.url, "git+https://github.com/Ebonyhtx/nibi-client.git");
  assert.deepEqual(manifest.publishConfig, { access: "public" });
});

test("invalid versions are rejected before packing", () => {
  assert.throws(() => metaPackageDependencies({ version: "v4.2.0" }), /invalid version/u);
  assert.throws(() => buildMetaPackageManifest({ version: "4..2" }), /invalid version/u);
});

test("packs only the launcher, manifest metadata and pinned dependencies", async () => {
  const outDir = join(root, "pack-out");
  const result = await packMetaPackage({ version: "4.2.0", outDir });

  assert.equal(result.name, "@nibi-studio/cli");
  assert.equal(result.version, "4.2.0");
  assert.match(result.integrity, /^sha512-/u);
  assert.deepEqual(result.platformPackages, buildMetaPackageManifest({ version: "4.2.0" }).optionalDependencies);

  const extractDir = join(root, "pack-extract");
  await mkdir(extractDir, { recursive: true });
  execFileSync(systemTar(), ["-xzf", result.tarball], { cwd: extractDir, stdio: "inherit" });

  const packageDir = join(extractDir, "package");
  assert.deepEqual((await readdir(join(packageDir, "bin"))).sort(), ["launcher.mjs", "nibi.js"]);
  assert.deepEqual((await readdir(packageDir)).sort(), [
    "LICENSE",
    "README.md",
    "bin",
    "package.json",
  ]);
  assert.deepEqual(
    await readFile(join(packageDir, "bin", "nibi.js")),
    await readFile(join(launcherDirectory, "nibi.js")),
  );
  assert.deepEqual(
    await readFile(join(packageDir, "bin", "launcher.mjs")),
    await readFile(join(launcherDirectory, "launcher.mjs")),
  );

  const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
  assert.deepEqual(manifest.optionalDependencies, result.platformPackages);
  assert.equal(manifest.bin.nibi, "bin/nibi.js");

  if (process.platform !== "win32") {
    assert.equal((await stat(join(packageDir, "bin", "nibi.js"))).mode & 0o777, 0o755);
  }
});

test("resolves bin/nibi-rs from the installed platform package", () => {
  const resolved = resolvePlatformBinary({
    platform: "linux",
    arch: "x64",
    requireFrom: resolveRequireFrom,
  });
  assert.equal(resolved.packageName, "@nibi-studio/cli-linux-x64-gnu");
  assert.equal(
    resolved.binaryPath,
    join(resolveFixture, "node_modules", "@nibi-studio", "cli-linux-x64-gnu", "bin", "nibi-rs"),
  );
});

test("a missing optional platform package produces an actionable error", () => {
  assert.throws(
    () =>
      resolvePlatformBinary({
        platform: "darwin",
        arch: "arm64",
        requireFrom: resolveRequireFrom,
      }),
    /@nibi-studio\/cli-darwin-arm64 package is not installed for darwin-arm64; reinstall @nibi-studio\/cli with optional dependencies enabled/u,
  );
});

test("the child environment carries every updater marker nibi update reads", () => {
  const env = managedEnvironment({
    platformPackage: "@nibi-studio/cli-linux-x64-gnu",
    env: { PATH: "/usr/bin" },
    launcherUrl: resolveRequireFrom,
  });
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    NIBI_MANAGED_BY_NPM: "1",
    NIBI_MANAGED_PACKAGE: "@nibi-studio/cli",
    NIBI_MANAGED_PLATFORM_PACKAGE: "@nibi-studio/cli-linux-x64-gnu",
  });

  // 父进程已经标了 pnpm 时不降级成 npm。
  const pnpm = managedEnvironment({
    platformPackage: "@nibi-studio/cli-linux-x64-gnu",
    env: { NIBI_MANAGED_BY_PNPM: "" },
    launcherUrl: resolveRequireFrom,
  });
  assert.equal(pnpm.NIBI_MANAGED_BY_PNPM, "1");
  assert.equal(pnpm.NIBI_MANAGED_BY_NPM, undefined);
  assert.throws(() => managedEnvironment({ platformPackage: "" }), /requires the resolved platform package/u);
});

test("manager detection follows user agent and pnpm/bun global layouts", () => {
  assert.equal(
    detectManagerMarker({ env: {}, launcherUrl: "file:///usr/local/lib/node_modules/@nibi-studio/cli/bin/launcher.mjs" }),
    "NIBI_MANAGED_BY_NPM",
  );
  assert.equal(
    detectManagerMarker({
      env: { npm_config_user_agent: "pnpm/10.33.2 npm/? node/v24.0.0" },
      launcherUrl: "file:///usr/local/lib/node_modules/@nibi-studio/cli/bin/launcher.mjs",
    }),
    "NIBI_MANAGED_BY_PNPM",
  );
  assert.equal(
    detectManagerMarker({
      env: {},
      launcherUrl: "file:///home/u/.local/share/pnpm/global/5/node_modules/@nibi-studio/cli/bin/launcher.mjs",
    }),
    "NIBI_MANAGED_BY_PNPM",
  );
  assert.equal(
    detectManagerMarker({
      env: {},
      launcherUrl: "file:///home/u/.bun/install/global/node_modules/@nibi-studio/cli/bin/launcher.mjs",
    }),
    "NIBI_MANAGED_BY_BUN",
  );
});

test("signals are forwarded to the child and handlers are removed on exit", () => {
  const processRef = new EventEmitter();
  const calls = [];
  const child = { kill: (signal) => calls.push(signal) };
  const stop = forwardSignals(child, { processRef });
  for (const signal of FORWARDED_SIGNALS) processRef.emit(signal);
  assert.deepEqual(calls, [...FORWARDED_SIGNALS]);
  stop();
  processRef.emit("SIGINT");
  assert.deepEqual(calls, [...FORWARDED_SIGNALS]);
});

test("runLauncher spawns the platform binary with inherited stdio and the child exit code", () => {
  const previousExitCode = process.exitCode;
  try {
    const { record, spawnImpl } = fakeSpawn();
    const child = runLauncher({
      argv: ["doctor", "--json"],
      env: { PATH: "/usr/bin" },
      platform: "linux",
      arch: "x64",
      requireFrom: resolveRequireFrom,
      spawnImpl,
      stderr: fakeStdio(),
    });
    assert.equal(child, record.child);
    assert.equal(
      record.call.command,
      join(resolveFixture, "node_modules", "@nibi-studio", "cli-linux-x64-gnu", "bin", "nibi-rs"),
    );
    assert.deepEqual(record.call.args, ["doctor", "--json"]);
    assert.equal(record.call.options.stdio, "inherit");
    assert.equal(record.call.options.env.NIBI_MANAGED_PACKAGE, "@nibi-studio/cli");
    assert.equal(
      record.call.options.env.NIBI_MANAGED_PLATFORM_PACKAGE,
      "@nibi-studio/cli-linux-x64-gnu",
    );
    assert.equal(record.call.options.env.NIBI_MANAGED_BY_NPM, "1");

    child.emit("exit", 7, null);
    assert.equal(process.exitCode, 7);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("signal exits use the shell's 128+signal convention", () => {
  const previousExitCode = process.exitCode;
  try {
    const { record, spawnImpl } = fakeSpawn();
    const child = runLauncher({
      platform: "linux",
      arch: "x64",
      requireFrom: resolveRequireFrom,
      spawnImpl,
      stderr: fakeStdio(),
    });
    child.emit("exit", null, "SIGINT");
    assert.equal(process.exitCode, 130);
    assert.equal(record.signal, undefined);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("unsupported platforms and missing packages exit 1 with a readable message", () => {
  const previousExitCode = process.exitCode;
  try {
    const unsupported = fakeStdio();
    runLauncher({
      platform: "win32",
      arch: "x64",
      requireFrom: resolveRequireFrom,
      spawnImpl: () => {
        throw new Error("must not spawn");
      },
      stderr: unsupported,
    });
    assert.equal(process.exitCode, 1);
    assert.match(unsupported.text, /unsupported platform win32-x64/u);

    const missing = fakeStdio();
    runLauncher({
      platform: "darwin",
      arch: "arm64",
      requireFrom: resolveRequireFrom,
      spawnImpl: () => {
        throw new Error("must not spawn");
      },
      stderr: missing,
    });
    assert.equal(process.exitCode, 1);
    assert.match(missing.text, /not installed for darwin-arm64/u);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("the real launcher forwards argv/stdio and exposes the native exit code", { skip: process.platform === "win32" }, async (t) => {
  const platformKey = `${process.platform}-${process.arch}`;
  const packageName = PLATFORM_PACKAGES[platformKey];
  if (!packageName) {
    t.skip(`no published platform package for ${platformKey}`);
    return;
  }

  const appDirectory = join(root, "e2e-app");
  const argsFile = join(root, "e2e-args.txt");
  const envFile = join(root, "e2e-env.txt");
  await writeFakePlatformPackage({
    appDirectory,
    packageName,
    executable: `#!/bin/sh
printf '%s\\n' "$@" > "$NIBI_TEST_ARGS"
printf '%s\\n' "$NIBI_MANAGED_BY_NPM" "$NIBI_MANAGED_PACKAGE" "$NIBI_MANAGED_PLATFORM_PACKAGE" > "$NIBI_TEST_ENV"
exit 7
`,
  });
  const entry = await stageLauncher(appDirectory);

  await assert.rejects(
    execFileAsync(process.execPath, [entry, "doctor", "--json"], {
      env: {
        ...process.env,
        NIBI_TEST_ARGS: argsFile,
        NIBI_TEST_ENV: envFile,
      },
    }),
    (error) => error.code === 7,
  );
  assert.equal(await readFile(argsFile, "utf8"), "doctor\n--json\n");
  assert.deepEqual((await readFile(envFile, "utf8")).trim().split("\n"), [
    "1",
    "@nibi-studio/cli",
    packageName,
  ]);
});
