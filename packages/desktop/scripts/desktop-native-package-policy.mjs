const SUPPORTED_DESKTOP_PLATFORM_KEYS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
];

// CUA 引擎的平台包按目标平台只留一个；其余平台包约 160MB，不该进安装包。
const CUA_DRIVER_PACKAGE_BY_TARGET = {
  "darwin-arm64": "@trycua/cua-driver-darwin-arm64",
  "darwin-x64": "@trycua/cua-driver-darwin-x64",
  "linux-arm64": "@trycua/cua-driver-linux-arm64-gnu",
  "linux-x64": "@trycua/cua-driver-linux-x64-gnu",
  "win32-arm64": "@trycua/cua-driver-win32-arm64-msvc",
  "win32-x64": "@trycua/cua-driver-win32-x64-msvc",
};

// koffi 2.15.6 自带 18 个平台的 native 目录；只保留目标平台那一份。
// 新增平台目录时这里不会自动命中，但 afterPack 的越界断言会让构建失败，避免静默带进包。
const KOFFI_NATIVE_DIRS = [
  "darwin_arm64",
  "darwin_x64",
  "freebsd_arm64",
  "freebsd_ia32",
  "freebsd_x64",
  "linux_arm64",
  "linux_armhf",
  "linux_ia32",
  "linux_loong64",
  "linux_riscv64d",
  "linux_x64",
  "musl_arm64",
  "musl_x64",
  "openbsd_ia32",
  "openbsd_x64",
  "win32_arm64",
  "win32_ia32",
  "win32_x64",
];
const KOFFI_NATIVE_DIR_BY_TARGET = {
  "darwin-arm64": "darwin_arm64",
  "darwin-x64": "darwin_x64",
  "linux-arm64": "linux_arm64",
  "linux-x64": "linux_x64",
  "win32-arm64": "win32_arm64",
  "win32-x64": "win32_x64",
};

function assertSupportedTargetPlatformKey(targetPlatformKey) {
  if (!SUPPORTED_DESKTOP_PLATFORM_KEYS.includes(targetPlatformKey)) {
    throw new Error(`不支持的桌面目标平台: ${targetPlatformKey}`);
  }
}

export function createDesktopNativePackagePrunePatterns(targetPlatformKey) {
  assertSupportedTargetPlatformKey(targetPlatformKey);

  return [
    // PDF 预览已经由 Vite 打进 renderer，pdfjs-dist 的 Canvas optional dependency
    // 只服务 Node 渲染；pnpm 跨平台安装的 8 套 Canvas native 不应带进桌面安装包。
    "!node_modules/@napi-rs/canvas/**",
    "!node_modules/@napi-rs/canvas-*/**",
    // Linux prebuild 会在 beforePack 复制进 node-pty；源平台包本身不属于桌面运行时。
    "!node_modules/@lydell/node-pty-*/**",
    // 桌面运行时统一使用目标 prebuild，禁止把安装机现场编译物或 ABI bin 缓存带进跨平台包。
    "!node_modules/node-pty/build/**",
    "!node_modules/node-pty/bin/**",
    ...SUPPORTED_DESKTOP_PLATFORM_KEYS.filter((key) => key !== targetPlatformKey).map(
      (key) => `!node_modules/node-pty/prebuilds/${key}/**`,
    ),
    // CUA 引擎与 koffi 同样只留目标平台：其它平台包在 Windows 包里合计约 190MB。
    ...SUPPORTED_DESKTOP_PLATFORM_KEYS.filter((key) => key !== targetPlatformKey).map(
      (key) => `!node_modules/${CUA_DRIVER_PACKAGE_BY_TARGET[key]}/**`,
    ),
    ...KOFFI_NATIVE_DIRS.filter(
      (dir) => dir !== KOFFI_NATIVE_DIR_BY_TARGET[targetPlatformKey],
    ).map((dir) => `!node_modules/koffi/build/koffi/${dir}/**`),
  ];
}

function normalizeAsarPath(path) {
  const normalized = path.trim().replaceAll("\\", "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function parseAsarListWithPackState(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(pack|unpack)\s*:\s*(.+)$/.exec(line);
      if (!match) {
        throw new Error(`无法解析 asar pack state: ${line}`);
      }
      return { packState: match[1], path: normalizeAsarPath(match[2]) };
    });
}

function isNativeRuntimeFile(path, targetPlatformKey) {
  if (/\.(?:node|dll|dylib|exe)$/i.test(path)) return true;
  return path === `/node_modules/node-pty/prebuilds/${targetPlatformKey}/spawn-helper`;
}

export function findDesktopNativePackageViolations(entries, targetPlatformKey) {
  assertSupportedTargetPlatformKey(targetPlatformKey);
  const violations = [];

  for (const entry of entries) {
    const { packState, path } = entry;

    if (
      path === "/node_modules/@napi-rs/canvas" ||
      path.startsWith("/node_modules/@napi-rs/canvas/") ||
      path.startsWith("/node_modules/@napi-rs/canvas-")
    ) {
      violations.push(`不应打包 renderer 无需的 Canvas native: ${path}`);
      continue;
    }

    if (path.startsWith("/node_modules/@lydell/node-pty-")) {
      violations.push(`不应打包仅用于准备 prebuild 的平台源包: ${path}`);
      continue;
    }

    if (
      path.startsWith("/node_modules/node-pty/build/") ||
      path.startsWith("/node_modules/node-pty/bin/")
    ) {
      violations.push(`不应打包安装机生成的 node-pty 产物: ${path}`);
      continue;
    }

    const nodePtyPrebuildMatch = /^\/node_modules\/node-pty\/prebuilds\/([^/]+)/.exec(path);
    if (nodePtyPrebuildMatch && nodePtyPrebuildMatch[1] !== targetPlatformKey) {
      violations.push(`node-pty 包含非目标平台 prebuild: ${path}`);
      continue;
    }

    const cuaDriverPackageMatch = /^\/node_modules\/@trycua\/(cua-driver-[^/]+)/u.exec(path);
    if (
      cuaDriverPackageMatch &&
      `@trycua/${cuaDriverPackageMatch[1]}` !== CUA_DRIVER_PACKAGE_BY_TARGET[targetPlatformKey]
    ) {
      violations.push(`CUA 引擎包含非目标平台包: ${path}`);
      continue;
    }

    const koffiNativeMatch = /^\/node_modules\/koffi\/build\/koffi\/([^/]+)/.exec(path);
    if (koffiNativeMatch && koffiNativeMatch[1] !== KOFFI_NATIVE_DIR_BY_TARGET[targetPlatformKey]) {
      violations.push(`koffi 包含非目标平台 native: ${path}`);
      continue;
    }

    if (isNativeRuntimeFile(path, targetPlatformKey) && packState !== "unpack") {
      violations.push(`native 文件仍作为 packed payload 留在 app.asar: ${path}`);
    }
  }

  return violations;
}
