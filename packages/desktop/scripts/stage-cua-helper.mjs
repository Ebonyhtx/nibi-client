/**
 * 把 Computer Use Helper 打成"产品态运行时目录"（`<resources>/tools/cua-helper/`）。
 *
 * 宿主侧的校验契约在 packages/services/src/cua-permission-broker/windowsCuaDevRuntime.ts：
 *   · 目录里必须有 `runtime-manifest.json`，必需键**恰好**是：
 *     schemaVersion(=1) / packageName(=@nibi/cua) / packageVersion / platform(win32) /
 *     arch(x64|arm64) / electronVersion(=打包版 Electron) / entry / addon / sha256{entry,addon}；
 *     另有可选键 runtimeDependencies（我们的 producer 用它声明引擎包，上游不写）。
 *   · entry / addon 是**相对路径**且都要能被 sha256 对上（校验失败一律拒绝启动）。
 * 所以本脚本负责：拷自己（helper/engine/runtime/broker/package.json）、拷引擎（@trycua/cua-driver
 * 及其平台包与 MPL-2.0 的 @ubjs/*）、写清单、附 NOTICE。
 *
 * 用法：
 *   node scripts/stage-cua-helper.mjs                         # win32/x64，输出到 <repo>/.staging/tools/cua-helper
 *   node scripts/stage-cua-helper.mjs --out D:/tmp/resources/tools/cua-helper --electron-version 40.2.1
 *   node scripts/stage-cua-helper.mjs --arch arm64 --platform win32
 * 说明：macOS 侧的宿主解析器还没写（上游那套 macOS 是 app bundle + 另一条 installer 路径），
 * 本脚本先把目录与清单做出来，等 macOS 通道就绪直接复用。
 */
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getTargetPlatform } from "./target-platform.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const PACKAGE_ROOT = join(REPO_ROOT, "packages", "zcode-cua");

function parseArgs(argv) {
  // 默认跟打包链的目标平台一致（getTargetPlatform 认 NIBI_TARGET_PLATFORM 等环境变量）。
  const target = getTargetPlatform();
  const args = { platform: target.os, arch: target.arch, out: "", electronVersion: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--platform") args.platform = argv[index + 1];
    else if (token === "--arch") args.arch = argv[index + 1];
    else if (token === "--out") args.out = argv[index + 1];
    else if (token === "--electron-version") args.electronVersion = argv[index + 1];
  }
  return args;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 找包目录：**不要** require.resolve —— 上游的 exports 映射既可能不暴露 `./package.json`，
 * 也可能没有可解析的 main（实测两种都撞上：ERR_PACKAGE_PATH_NOT_EXPORTED）。这里直接按
 * node_modules 逐级向上找目录，pnpm 的符号链接布局同样适用。
 */
async function packageJsonOf(specifier, fromDir) {
  let directory = resolve(fromDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, "node_modules", ...specifier.split("/"), "package.json");
    if (existsSync(candidate)) {
      return { path: candidate, data: JSON.parse(await readFile(candidate, "utf8")) };
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`在 ` + fromDir + ` 向上的 node_modules 里找不到 ` + specifier);
}

async function copyTree(from, to) {
  await cp(from, to, { recursive: true, force: true, dereference: true });
}

const args = parseArgs(process.argv.slice(2));
// 默认输出**按产品布局**：<resources>/tools/cua-helper（宿主 resolvePackagedRuntime 就是找这一层）
const outDir = resolve(args.out || join(REPO_ROOT, ".staging", "tools", "cua-helper"));

/**
 * 引擎平台件：与 @trycua/cua-driver 的 optionalDependencies 对齐。
 * `native` 是运行时动态库（win=dll / mac=dylib / linux=so），`addon` 是 N-API 入口。
 */
const PLATFORM_PACKAGES = {
  win32: {
    x64: { package: "@trycua/cua-driver-win32-x64-msvc", native: "cua_driver_sdk.dll" },
    arm64: { package: "@trycua/cua-driver-win32-arm64-msvc", native: "cua_driver_sdk.dll" },
  },
  darwin: {
    x64: { package: "@trycua/cua-driver-darwin-x64", native: "cua_driver_sdk.dylib" },
    arm64: { package: "@trycua/cua-driver-darwin-arm64", native: "cua_driver_sdk.dylib" },
  },
  linux: {
    x64: { package: "@trycua/cua-driver-linux-x64-gnu", native: "cua_driver_sdk.so" },
    arm64: { package: "@trycua/cua-driver-linux-arm64-gnu", native: "cua_driver_sdk.so" },
  },
};
const platformEntry = PLATFORM_PACKAGES[args.platform]?.[args.arch];
if (!platformEntry) throw new Error(`不支持的平台/架构：${args.platform}/${args.arch}`);
const platformPackageName = platformEntry.package;
const nativeFileName = platformEntry.native;
const addonFileName = "cua_driver_node_runtime.node";

const packageJsonPath = join(PACKAGE_ROOT, "package.json");
const ourPackage = JSON.parse(await readFile(packageJsonPath, "utf8"));
const driverPackage = await packageJsonOf("@trycua/cua-driver", PACKAGE_ROOT);
const platformPackage = await packageJsonOf(platformPackageName, PACKAGE_ROOT);
const electronVersion =
  args.electronVersion ||
  JSON.parse(await readFile(join(REPO_ROOT, "node_modules/electron/package.json"), "utf8")).version;

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

// 1) 我们自己那份（helper / engine / runtime / 协议 / 清单）
for (const entry of ["helper", "engine", "runtime", "broker.js", "index.js", "package.json", "LICENSE"]) {
  const source = join(PACKAGE_ROOT, entry);
  if (!existsSync(source)) throw new Error(`缺文件：${source}`);
  await copyTree(source, join(outDir, entry));
}
await copyTree(join(PACKAGE_ROOT, "vendor", "freeall12-computer-use", "LICENSE"), join(outDir, "THIRD-PARTY-freeall12-LICENSE"));

// 2) 引擎（@trycua/cua-driver + 平台包 + MPL-2.0 的 @ubjs/*）
const driverRoot = join(outDir, "node_modules", "@trycua", "cua-driver");
await mkdir(driverRoot, { recursive: true });
await copyTree(join(dirname(driverPackage.path), "dist"), join(driverRoot, "dist"));
await writeFile(join(driverRoot, "package.json"), driverPackage.data ? JSON.stringify(driverPackage.data, null, 2) : "{}\n");
const platformRoot = join(outDir, "node_modules", "@trycua", platformPackageName.split("/")[1]);
await mkdir(platformRoot, { recursive: true });
for (const file of [addonFileName, nativeFileName, "node-runtime-NOTICE.md", "package.json"]) {
  const source = join(dirname(platformPackage.path), file);
  if (existsSync(source)) await copyTree(source, join(platformRoot, file));
}
for (const shared of ["@ubjs/core", "@ubjs/node"]) {
  const found = await packageJsonOf(shared, PACKAGE_ROOT);
  const target = join(outDir, "node_modules", ...shared.split("/"));
  await copyTree(dirname(found.path), target);
}

// 3) 清单（键必须**恰好**是宿主校验的那九个）
const entryRelative = join("helper", "main.js").replace(/\\/g, "/");
const addonRelative = join("node_modules", "@trycua", platformPackageName.split("/")[1], addonFileName).replace(/\\/g, "/");
const manifest = {
  schemaVersion: 1,
  packageName: "@nibi/cua",
  packageVersion: ourPackage.version,
  platform: args.platform,
  arch: args.arch,
  electronVersion,
  entry: entryRelative,
  addon: addonRelative,
  // 我们的 Helper 只用引擎包（node 内建 + @trycua），不依赖上游的 express/sharp。
  // 打包后 afterPack 按这份清单验运行时依赖闭包（可选扩展键）。
  runtimeDependencies: ["@trycua/cua-driver", platformPackageName],
  sha256: {
    entry: sha256File(join(outDir, entryRelative)),
    addon: sha256File(join(outDir, addonRelative)),
  },
};
await writeFile(join(outDir, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

// 3b) 让同一个目录**也能当 dev 根**：宿主侧的 dev 通道（NIBI_CUA_DEV_ROOT）读的是
//     package.json 里的 `zcodeCuaRuntime` 契约（**精确键**：schema/windows{entry,nativeAddon}，
//     路径要规范相对形式——不含反斜杠、无 ./ 前缀、无 .. 段，见 resolveDevelopmentRuntime）。
//     产品通道只读 runtime-manifest.json，两者互不干扰。
const stagedPackagePath = join(outDir, "package.json");
const stagedPackage = JSON.parse(await readFile(stagedPackagePath, "utf8"));
stagedPackage.zcodeCuaRuntime = {
  schema: 1,
  windows: {
    entry: entryRelative,
    nativeAddon: addonRelative,
  },
};
await writeFile(stagedPackagePath, `${JSON.stringify(stagedPackage, null, 2)}
`, "utf8");

// 4) NOTICE（MIT + MPL-2.0；两份都随包带上）
await writeFile(
  join(outDir, "NOTICE.md"),
  `# Computer Use Helper —— 第三方组件

本目录是 NIBI 的 Computer Use Helper（宿主契约见客户端 packages/services/src/cua-permission-broker）。
原生能力来自下列第三方组件，随包分发时保留其许可与声明：

| 组件 | 版本 | 许可 | 说明 |
| --- | --- | --- | --- |
| \`@trycua/cua-driver\` | ${driverPackage.data.version} | MIT | 桌面自动化引擎（https://github.com/trycua/cua） |
| \`${platformPackageName}\` | ${platformPackage.data.version} | MIT AND MPL-2.0 | 该平台的预编译原生件 |
| \`@ubjs/core\`、\`@ubjs/node\` | ${(await packageJsonOf("@ubjs/core", PACKAGE_ROOT)).data.version} | MPL-2.0 | UniFFI JS 运行时（uniffi-bindgen-react-native，文件级 copyleft；未修改，源码见上游仓库） |
| freeall12/computer-use 文档与参考实现 | 快照 | MIT | 规格与测试用；见 packages/zcode-cua/vendor/ 的 PROVENANCE.md |

未分发 cua 的 \`cua-perception\` 扩展（其 OmniParser 依赖是 AGPL-3.0）。
`,
  "utf8",
);

console.log(`✓ 已打 Computer Use Helper：${relative(REPO_ROOT, outDir) || outDir}`);
console.log(`  platform=${args.platform}/${args.arch} electron=${electronVersion} version=${ourPackage.version}`);
console.log(`  entry=${entryRelative} (${manifest.sha256.entry.slice(0, 12)}…)`);
console.log(`  addon=${addonRelative} (${manifest.sha256.addon.slice(0, 12)}…)`);
