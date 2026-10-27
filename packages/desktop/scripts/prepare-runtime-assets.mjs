#!/usr/bin/env node

import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNativeSearchReleasePlan } from "../../../scripts/native-search-tools-config.mjs";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { getTargetPlatform } from "./target-platform.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const target = getTargetPlatform();
const nativeSearchReleasePlan = resolveNativeSearchReleasePlan({
  platform: target.os,
  arch: target.arch,
});
// Windows Chrome 导入入口未启用，默认构建继续编译 helper 会增加 CI 时间和发布签名面。
// 保留显式开关，后续恢复入口时仍可复用既有原生实现和供应链校验。
const shouldPrepareWindowsBrowserImportHelper =
  target.os === "win32" && process.env.NIBI_ENABLE_WINDOWS_BROWSER_IMPORT === "1";
// CUA 权限浮窗的吸附数据源。仅 macOS；缺 swiftc 时脚本内部自行降级为跳过（浮窗 fail-open
// 到屏幕底部，仍可用），所以无条件挂在 darwin 上不会让构建变脆。
const shouldPrepareMacosWindowBounds = target.os === "darwin";
// Computer Use Helper：把引擎（@trycua/cua-driver）与我们的 helper 打成产品态目录
// `<resources>/tools/cua-helper`（含 runtime-manifest.json，宿主会校验 entry/addon 的 sha256）。
// 目前宿主侧的解析器只有 Windows 分支（macOS 是另一条 installer 路径），所以先只在 win32 上出包。
const shouldPrepareCuaHelper = target.os === "win32" || process.env.NIBI_ENABLE_CUA_HELPER === "1";

// 本机桌面包不再内置 glm 原生二进制（prepare:glm），改为内置 agent 的 JS bundle（prepare:agent-bundle），
// 运行时由 app 的 Electron Node runtime 执行。Source Server 资源由独立 stage:remote-assets 入口负责。
const localRuntimeScripts = [
  ...(shouldPrepareCuaHelper ? ["prepare:cua-helper"] : []),
  "prepare:agent-bundle",
  // 2026-10-26：不再跑 `prepare:windows-cua-helper`（上游契约路径）。它按
  // `<package>/node_modules/@trycua/...` 找原生件，而 pnpm 的 hoisted 布局把它放在仓库根，
  // 于是必然 ENOENT；我们自己的 `prepare:cua-helper`（stage-cua-helper）已经产出同样的
  // 产品态目录（含 node_modules 与 runtime-manifest.json），打包直接取 `.staging`。
  // `shouldPrepareWindowsCuaHelper` 仍用于决定是否断言打包结果（见 electron-builder afterPack）。
  ...(nativeSearchReleasePlan.enabled ? ["prepare:native-search"] : []),
  ...(shouldPrepareWindowsBrowserImportHelper ? ["prepare:browser-import-helper"] : []),
  ...(shouldPrepareMacosWindowBounds ? ["prepare:macos-window-bounds"] : []),
];

function runTimedPnpmScript(scriptName) {
  const startMs = Date.now();
  console.log(`[ci][timer] prepare-runtime-assets:${scriptName} start`);
  try {
    runCommand(pnpmCommand, [scriptName], {
      cwd: desktopRoot,
      env: process.env,
    });
  } finally {
    console.log(
      `[ci][timer] prepare-runtime-assets:${scriptName} end duration_ms=${Date.now() - startMs}`,
    );
  }
}

for (const scriptName of localRuntimeScripts) {
  runTimedPnpmScript(scriptName);
}
