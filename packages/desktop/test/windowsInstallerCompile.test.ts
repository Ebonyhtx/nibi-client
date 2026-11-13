import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const desktopDir = resolve(import.meta.dirname, "..");
const builderDir = dirname(require.resolve("app-builder-lib/package.json"));

it("compiles real UAC calls when the plugin directory follows the custom include", async (context) => {
  // NSIS 自带的 mac 编译器是 x86_64；Apple Silicon 缺少 Rosetta 时只跳过此环境不支持的编译测试。
  if (process.platform === "darwin" && process.arch === "arm64") {
    try {
      await execFileAsync("/usr/bin/arch", ["-x86_64", "/usr/bin/true"]);
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      if (stderr.includes("Bad CPU type in executable")) {
        context.skip("NSIS x86_64 compiler requires Rosetta on Apple Silicon");
        return;
      }
      throw error;
    }
  }
  // 26.15 起上游用 out/toolsets/windows 的 getMakeNsisPath / getNsisPluginsPath
  // 替换了 nsisUtil 的 NSIS_PATH / NSIS_RESOURCES_PATH / NsisTargetOptions，
  // 26.17.0 起旧导出已被删除。只消费这两个公开 helper，不再依赖内部 target 选项。
  const { getMakeNsisPath, getNsisPluginsPath } = require(
    resolve(builderDir, "out/toolsets/windows.js"),
  ) as {
    getMakeNsisPath: (
      nsis?: string,
      customBinary?: unknown,
    ) => Promise<{ path: string; env?: Record<string, string> }>;
    getNsisPluginsPath: (nsis?: string, customResources?: unknown) => Promise<string>;
  };
  const makensis = await getMakeNsisPath(undefined, undefined);
  // legacy bundle 才显式带 NSISDIR；fallback 按 legacy 布局
  // （<bundle>/{Bin,linux,mac}/makensis[.exe]）反推。
  const nsisDir = makensis.env?.NSISDIR ?? dirname(dirname(makensis.path));
  // 新版返回 plugins 根目录（旧版返回 resources 根，需再拼一层 "plugins"）。
  const pluginsDir = await getNsisPluginsPath(undefined, undefined);
  const compiler = makensis.path;
  const temp = await mkdtemp(join(tmpdir(), "nibi-nsis-compile-"));
  try {
    for (const uninstaller of [false, true]) {
      const output = join(temp, uninstaller ? "uninstaller.exe" : "installer.exe");
      // 只编译不执行：载荷复用当前文件，所有平台都能验证真实 NSIS 插件解析。
      const args = [
        "-V2",
        "-INPUTCHARSET",
        "UTF8",
        ...(uninstaller ? ["-WX", "-DBUILD_UNINSTALLER"] : []),
        `-DNSIS_INCLUDE_DIR=${join(nsisDir, "Include")}`,
        `-DELECTRON_BUILDER_NSIS_INCLUDE_DIR=${join(builderDir, "templates/nsis/include")}`,
        `-DNSIS_PLUGIN_DIR=${join(pluginsDir, "x86-unicode")}`,
        `-DNIBI_INSTALLER_NSH=${join(desktopDir, "build/installer.nsh")}`,
        `-DFIXTURE_EXE=${import.meta.filename}`,
        `-DOUTPUT_FILE=${output}`,
        `-DDEFAULT_LOG_PATH=${join(temp, "default.log")}`,
        `-DELEVATED_LOG_PATH=${join(temp, "elevated.log")}`,
        join(desktopDir, "test/fixtures/installer-nsh-smoke.nsi"),
      ];
      await execFileAsync(compiler, args, { env: { ...process.env, NSISDIR: nsisDir } });
      expect((await stat(output)).size).toBeGreaterThan(0);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}, 120_000);
