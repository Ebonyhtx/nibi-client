import { describe, expect, it } from "vitest";
import {
  resolveWorkspaceShellPanelRadiusPx,
  resolveWorkspaceShellResizeHandleInsetPx,
  resolveWorkspaceShellWindowChromeClass,
} from "../src/app-shell/workspaceShellWindowChrome.js";

describe("resolveWorkspaceShellWindowChromeClass", () => {
  it("uses 12px corners on macOS Sequoia and earlier", () => {
    expect(
      resolveWorkspaceShellWindowChromeClass({
        isMacDesktop: true,
        macOSMajorVersion: 15,
        isWindowsDesktop: false,
        isWindowsMaximized: false,
        supportsNativeRoundedCorners: false,
      }),
    ).toBe("rounded-xl border border-border/75");
  });

  it("uses 18px Folio corners on macOS Tahoe and later", () => {
    expect(
      resolveWorkspaceShellWindowChromeClass({
        isMacDesktop: true,
        macOSMajorVersion: 26,
        isWindowsDesktop: false,
        isWindowsMaximized: false,
        supportsNativeRoundedCorners: false,
      }),
    ).toBe("rounded-[18px] border border-border/75");
  });

  it("uses 18px Folio corners in Windows 11 normal windows", () => {
    expect(
      resolveWorkspaceShellWindowChromeClass({
        isWindowsDesktop: true,
        isWindowsMaximized: false,
        supportsNativeRoundedCorners: true,
      }),
    ).toBe("rounded-[18px] border border-border/75");
  });

  it("uses symmetric 18px Folio corners for the inset sheet on Windows 10 too", () => {
    expect(
      resolveWorkspaceShellWindowChromeClass({
        isWindowsDesktop: true,
        isWindowsMaximized: false,
        supportsNativeRoundedCorners: false,
      }),
    ).toBe("rounded-[18px] border border-border/75");
  });

  it("preserves the existing Folio appearance while Windows capability is unknown", () => {
    expect(
      resolveWorkspaceShellWindowChromeClass({
        isWindowsDesktop: true,
        isWindowsMaximized: false,
        supportsNativeRoundedCorners: null,
      }),
    ).toBe("rounded-[18px] border border-border/75");
  });
});

it("uses 18px Folio corners on Linux", () => {
  expect(
    resolveWorkspaceShellWindowChromeClass({
      isLinuxDesktop: true,
      isWindowsDesktop: false,
      isWindowsMaximized: false,
      supportsNativeRoundedCorners: false,
    }),
  ).toBe("rounded-[18px] border border-border/75");
});

describe("workspace shell resize handle inset", () => {
  it.each([
    ["macOS Sequoia", { isMacDesktop: true, macOSMajorVersion: 15 }, 12, 12],
    ["unknown macOS", { isMacDesktop: true, macOSMajorVersion: null }, 18, 18],
    ["macOS Sonoma", { isMacDesktop: true, macOSMajorVersion: 14 }, 12, 12],
    ["Web", {}, 18, 18],
    ["macOS Tahoe", { isMacDesktop: true, macOSMajorVersion: 26 }, 18, 18],
    ["Windows", { isWindowsDesktop: true }, 18, 18],
    ["Linux", { isLinuxDesktop: true }, 18, 18],
  ] as const)(
    "aligns %s handle with the start of the straight edge",
    (_name, platform, radius, inset) => {
      expect(resolveWorkspaceShellPanelRadiusPx(platform)).toBe(radius);
      expect(resolveWorkspaceShellResizeHandleInsetPx(platform)).toBe(inset);
    },
  );
});
