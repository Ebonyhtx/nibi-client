// Build the Windows-only native runtime host helper.
//
// This script is intentionally a plain Node ESM module and always passes
// arguments as an array to spawn(), so Git Bash never rewrites "/"-prefixed
// arguments into paths. On non-Windows hosts it exits successfully without
// building anything, which keeps it out of non-Windows packaging.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const scriptDir = import.meta.dirname;
const source = join(scriptDir, "windows-runtime-host");
const helperName = "nibi-runtime-host.exe";
const installerHelperName = "nibi-installer-process-helper.exe";
const sourceNames = ["main.cpp", "installer-process-helper.cpp", "CMakeLists.txt"];

export function resolveRuntimeHostBuild(arch, hostPlatform = process.platform) {
  if (arch !== "x64" && arch !== "arm64")
    throw new Error(`Unsupported runtime host architecture: ${arch}`);
  if (hostPlatform !== "win32")
    throw new Error("The runtime host helper can only be built on Windows");
  return {
    configureArgs: ["-G", "Visual Studio 17 2022", "-A", arch === "arm64" ? "ARM64" : "x64"],
  };
}

export function verifyRuntimeHostPe(bytes, arch) {
  const header = bytes.length >= 64 ? bytes.readUInt32LE(60) : -1;
  if (
    bytes.toString("ascii", 0, 2) !== "MZ" ||
    header < 0 ||
    header + 6 > bytes.length ||
    bytes.toString("ascii", header, header + 4) !== "PE\0\0"
  ) {
    throw new Error("Invalid runtime host PE binary");
  }
  if (bytes.readUInt16LE(header + 4) !== (arch === "arm64" ? 0xaa64 : 0x8664))
    throw new Error("Runtime host architecture mismatch");
}

async function sourceDigest() {
  const hash = createHash("sha256");
  for (const name of sourceNames) hash.update(await readFile(join(source, name)));
  return hash.digest("hex");
}

function run(args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.env.CMAKE || "cmake", args, {
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolveRun() : reject(new Error(`Runtime host CMake failed: ${code}`)),
    );
  });
}

export async function isRuntimeHostReady(outputDir, arch) {
  try {
    const hostBytes = await readFile(join(outputDir, helperName));
    const installerHelperBytes = await readFile(join(outputDir, installerHelperName));
    verifyRuntimeHostPe(hostBytes, arch);
    verifyRuntimeHostPe(installerHelperBytes, arch);
    const manifest = JSON.parse(await readFile(join(outputDir, "build.json"), "utf8"));
    return (
      manifest.source === (await sourceDigest()) &&
      manifest.binaries?.[helperName] === createHash("sha256").update(hostBytes).digest("hex") &&
      manifest.binaries?.[installerHelperName] ===
        createHash("sha256").update(installerHelperBytes).digest("hex")
    );
  } catch {
    return false;
  }
}

export async function buildRuntimeHost({ arch, outputDir }) {
  const plan = resolveRuntimeHostBuild(arch);
  const work = await mkdtemp(join(tmpdir(), "nibi-runtime-host-"));
  try {
    await run(["-S", source, "-B", work, ...plan.configureArgs, "-DCMAKE_BUILD_TYPE=Release"]);
    await run([
      "--build",
      work,
      "--config",
      "Release",
      "--target",
      "nibi-runtime-host",
      "nibi-installer-process-helper",
    ]);
    const releaseDir = join(work, "Release");
    const built = await readFile(join(releaseDir, helperName));
    const builtInstallerHelper = await readFile(join(releaseDir, installerHelperName));
    verifyRuntimeHostPe(built, arch);
    verifyRuntimeHostPe(builtInstallerHelper, arch);
    await mkdir(outputDir, { recursive: true });
    await copyFile(join(releaseDir, helperName), join(outputDir, helperName));
    await copyFile(
      join(releaseDir, installerHelperName),
      join(outputDir, installerHelperName),
    );
    await writeFile(
      join(outputDir, "build.json"),
      JSON.stringify({
        source: await sourceDigest(),
        binaries: {
          [helperName]: createHash("sha256").update(built).digest("hex"),
          [installerHelperName]: createHash("sha256")
            .update(builtInstallerHelper)
            .digest("hex"),
        },
      }),
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function main() {
  if (process.platform !== "win32") {
    console.log(`[windows-runtime-host] skipped: host platform is ${process.platform}`);
    return;
  }
  const args = process.argv.slice(2);
  const arch =
    args.find((arg) => arg.startsWith("--arch="))?.slice(7) || process.env.NIBI_TARGET_ARCH || process.arch;
  const outputDir =
    args.find((arg) => arg.startsWith("--output-dir="))?.slice(13) ||
    join(scriptDir, "..", "bundled-tools", `win32-${arch}`, "runtime-host");
  if (!args.includes("--ensure") || !(await isRuntimeHostReady(outputDir, arch))) {
    await buildRuntimeHost({ arch, outputDir });
    console.log(
      `[windows-runtime-host] built ${join(outputDir, helperName)} and ${join(
        outputDir,
        installerHelperName,
      )}`,
    );
  } else {
    console.log(`[windows-runtime-host] up to date ${join(outputDir, helperName)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
