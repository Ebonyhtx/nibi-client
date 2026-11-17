import { describe, expect, it } from "vitest";
import {
  createDesktopNativePackagePrunePatterns,
  findDesktopNativePackageViolations,
  parseAsarListWithPackState,
} from "../scripts/desktop-native-package-policy.mjs";

describe("desktop native package policy", () => {
  it("应裁剪 Canvas、node-pty 安装机产物和所有非目标平台 prebuild", () => {
    const patterns = createDesktopNativePackagePrunePatterns("darwin-arm64");

    expect(patterns).toContain("!node_modules/@napi-rs/canvas/**");
    expect(patterns).toContain("!node_modules/@napi-rs/canvas-*/**");
    expect(patterns).toContain("!node_modules/@lydell/node-pty-*/**");
    expect(patterns).toContain("!node_modules/node-pty/build/**");
    expect(patterns).toContain("!node_modules/node-pty/bin/**");
    expect(patterns).toContain("!node_modules/node-pty/prebuilds/darwin-x64/**");
    expect(patterns).toContain("!node_modules/node-pty/prebuilds/win32-arm64/**");
    expect(patterns).not.toContain("!node_modules/node-pty/prebuilds/darwin-arm64/**");
    expect(patterns).toContain("!node_modules/@trycua/cua-driver-darwin-x64/**");
    expect(patterns).not.toContain("!node_modules/@trycua/cua-driver-darwin-arm64/**");
    expect(patterns).toContain("!node_modules/koffi/build/koffi/win32_x64/**");
    expect(patterns).not.toContain("!node_modules/koffi/build/koffi/darwin_arm64/**");
  });

  it("应接受仅包含目标平台且正确 unpack 的 native 资源", () => {
    const entries = parseAsarListWithPackState(
      [
        "unpack : /node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
        "unpack : /node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
        "unpack : /node_modules/@trycua/cua-driver-darwin-arm64/cua_driver_sdk.dylib",
        "unpack : /node_modules/koffi/build/koffi/darwin_arm64/koffi.node",
        "pack   : /node_modules/node-pty/package.json",
      ].join("\n"),
    );

    expect(findDesktopNativePackageViolations(entries, "darwin-arm64")).toEqual([]);
  });

  it("应同时拒绝跨平台包、安装机产物和仍留在 asar payload 的 native", () => {
    const entries = parseAsarListWithPackState(
      [
        "pack   : \\node_modules\\@napi-rs\\canvas-win32-x64-msvc\\skia.node",
        "unpack : /node_modules/@lydell/node-pty-linux-x64/prebuilds/linux-x64/pty.node",
        "unpack : /node_modules/node-pty/build/Release/pty.node",
        "unpack : /node_modules/node-pty/prebuilds/win32-x64/pty.node",
        "unpack : /node_modules/@trycua/cua-driver-linux-x64-gnu/cua_driver_sdk.so",
        "unpack : /node_modules/koffi/build/koffi/win32_x64/koffi.node",
        "pack   : /node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
      ].join("\n"),
    );

    expect(findDesktopNativePackageViolations(entries, "darwin-arm64")).toEqual([
      expect.stringContaining("Canvas native"),
      expect.stringContaining("平台源包"),
      expect.stringContaining("安装机生成"),
      expect.stringContaining("非目标平台"),
      expect.stringContaining("CUA 引擎包含非目标平台包"),
      expect.stringContaining("koffi 包含非目标平台 native"),
      expect.stringContaining("packed payload"),
    ]);
  });
});
