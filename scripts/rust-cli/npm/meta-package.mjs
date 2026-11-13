#!/usr/bin/env node
// 把 `@nibi-studio/cli` META 包打成可发布的 tarball。
//
// META 包只做一件事：暴露全局 `nibi` 入口，并让 npm 按平台安装对应的
// `@nibi-studio/cli-<platform>` optionalDependency。真正的二进制在平台包里，
// 启动器把 argv/stdio/信号原样交给它，并设置 Rust `nibi update` 需要的标记。
//
// 平台包必须先于 META 发布：META 的 optionalDependencies 精确锁定同版本平台包，
// 任意一个缺失都会让 `npm install -g @nibi-studio/cli` 在该平台装不出可用的 `nibi`。
// 发布顺序由 `.github/workflows/rust-npm-packages.yml` 的 `publish` → `meta` 保证。
//
// 用法：
//   node scripts/rust-cli/npm/meta-package.mjs \
//     --version 5.0.0 \
//     --out <dir>
//
// 输出一行 JSON：包名、版本、tarball 路径、sha256/integrity、锁定的平台包。

import { execFileSync } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  META_PACKAGE_NAME,
  PLATFORM_PACKAGES,
} from "./bin/launcher.mjs";
import { isValidVersion, REPOSITORY_URL } from "./package.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultLauncherDirectory = resolve(scriptDirectory, "bin");
const defaultLicensePath = resolve(scriptDirectory, "../../../LICENSE");
const repositoryUrl = REPOSITORY_URL;

const README = `# ${META_PACKAGE_NAME}

NIBI CLI launcher. It installs the native \`nibi-rs\` kernel for the current
platform and exposes the global \`nibi\` command.

\`\`\`sh
npm install -g ${META_PACKAGE_NAME}
nibi --version
nibi doctor --json
\`\`\`

The platform package is chosen from \`process.platform\` and \`process.arch\`:

| Platform | Package |
| --- | --- |
${Object.entries(PLATFORM_PACKAGES)
  .map(([key, name]) => `| \`${key}\` | \`${name}\` |`)
  .join("\n")}

Unsupported platforms fail closed with an actionable error; they do not fall
back to another architecture. Linux packages target glibc (gnu). The
\`android-arm64\` package is distributed for NIBI-GO and does not use the Node
launcher.

The launcher sets \`NIBI_MANAGED_PACKAGE\`, \`NIBI_MANAGED_PLATFORM_PACKAGE\`
and the matching \`NIBI_MANAGED_BY_*\` marker in the child environment so
\`nibi update\` can update the npm package that owns this installation.
`;

/**
 * `optionalDependencies` 的平台包与版本。版本必须逐字相同（精确锁定，不用范围）。
 */
export function metaPackageDependencies({ version }) {
  if (!isValidVersion(version)) {
    throw new Error(`invalid version ${JSON.stringify(version)}`);
  }
  return Object.fromEntries(
    Object.values(PLATFORM_PACKAGES).map((packageName) => [packageName, version]),
  );
}

export function buildMetaPackageManifest({ version }) {
  const optionalDependencies = metaPackageDependencies({ version });
  return {
    name: META_PACKAGE_NAME,
    version,
    description: "NIBI CLI launcher for the native Rust kernel (nibi-rs)",
    license: "Apache-2.0",
    repository: { type: "git", url: repositoryUrl },
    homepage: "https://github.com/Ebonyhtx/nibi-client",
    bin: { nibi: "bin/nibi.js" },
    files: ["bin/nibi.js", "bin/launcher.mjs", "README.md", "LICENSE"],
    engines: { node: ">=18.0.0" },
    // 平台包在自己的 manifest 里声明 os/cpu，npm 只安装匹配当前平台的那一个。
    optionalDependencies,
    publishConfig: { access: "public" },
  };
}

/**
 * 在临时目录里搭 `package/`，跑 `npm pack`，把 tarball 放到 outDir。
 * 返回 `{ name, version, tarball, integrity, size, platformPackages }`。
 */
export async function packMetaPackage({
  version,
  outDir,
  launcherDirectory = defaultLauncherDirectory,
  licensePath = defaultLicensePath,
}) {
  const manifest = buildMetaPackageManifest({ version });

  await mkdir(outDir, { recursive: true });
  const stageRoot = await mkdtemp(join(tmpdir(), "nibi-cli-meta-"));
  const packageDir = join(stageRoot, "package");
  try {
    await mkdir(join(packageDir, "bin"), { recursive: true });
    await copyFile(join(launcherDirectory, "nibi.js"), join(packageDir, "bin", "nibi.js"));
    await copyFile(join(launcherDirectory, "launcher.mjs"), join(packageDir, "bin", "launcher.mjs"));
    // npm 会保留 tarball 里的执行位；bin 必须是可执行的。
    await chmod(join(packageDir, "bin", "nibi.js"), 0o755);
    await chmod(join(packageDir, "bin", "launcher.mjs"), 0o644);
    await writeFile(join(packageDir, "README.md"), README);
    await copyFile(licensePath, join(packageDir, "LICENSE"));
    await writeFile(
      join(packageDir, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

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
    return {
      name: manifest.name,
      version,
      tarball: resolve(outDir, entry.filename),
      integrity: entry.integrity,
      size: entry.size,
      platformPackages: manifest.optionalDependencies,
    };
  } finally {
    await rm(stageRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const args = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help" || flag === "-h") {
      args.help = true;
      continue;
    }
    if (!flag?.startsWith("--")) throw new Error(`unexpected argument ${JSON.stringify(flag)}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`missing value for ${flag}`);
    args[flag.slice(2)] = value;
    index += 1;
  }
  if (args.help) return args;
  for (const required of ["version", "out"]) {
    if (!args[required]) throw new Error(`missing --${required}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(
      "Usage: node scripts/rust-cli/npm/meta-package.mjs --version <version> --out <dir>\n",
    );
    return;
  }
  const result = await packMetaPackage({
    version: args.version,
    outDir: resolve(args.out),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(
      `[nibi-cli-meta] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

export { README };
