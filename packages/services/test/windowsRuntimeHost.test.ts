import { describe, expect, it, vi } from "vitest";
import {
  resolveWindowsRuntimeHostHelper,
  shouldUseWindowsRuntimeHost,
  trySpawnWindowsRuntimeHost,
} from "@nibi/services/windows-runtime-host";

const baseOptions = {
  command: "cmd.exe",
  args: ["/c", "exit 0"],
  cwd: process.cwd(),
  env: process.env,
  signal: new AbortController().signal,
};

describe("windows-runtime-host launch fallback", () => {
  it("is Windows-only", () => {
    expect(shouldUseWindowsRuntimeHost("win32")).toBe(true);
    expect(shouldUseWindowsRuntimeHost("linux")).toBe(false);
    expect(shouldUseWindowsRuntimeHost("darwin")).toBe(false);
  });

  it("skips on non-Windows and reports the explicit fallback", async () => {
    const warn = vi.fn();
    const runtime = await trySpawnWindowsRuntimeHost({
      ...baseOptions,
      platform: "linux",
      log: { warn },
    });
    expect(runtime).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("process-tree terminator fallback"),
      expect.objectContaining({ fallback: "process-tree-terminator", reason: "platform" }),
    );
  });

  it("falls back when the helper binary cannot be resolved", async () => {
    const warn = vi.fn();
    const runtime = await trySpawnWindowsRuntimeHost({
      ...baseOptions,
      platform: "win32",
      resolveHelper: async () => {
        throw new Error("helper missing");
      },
      log: { warn },
    });
    expect(runtime).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("process-tree terminator fallback"),
      expect.objectContaining({
        fallback: "process-tree-terminator",
        reason: "helper missing",
      }),
    );
  });

  it("honors NIBI_RUNTIME_HOST_PATH when resolving the helper", async () => {
    const previous = process.env.NIBI_RUNTIME_HOST_PATH;
    const helper = process.execPath;
    process.env.NIBI_RUNTIME_HOST_PATH = helper;
    try {
      await expect(resolveWindowsRuntimeHostHelper()).resolves.toBe(helper);
    } finally {
      if (previous === undefined) delete process.env.NIBI_RUNTIME_HOST_PATH;
      else process.env.NIBI_RUNTIME_HOST_PATH = previous;
    }
  });

  it("reports a missing helper with a build hint", async () => {
    const previous = process.env.NIBI_RUNTIME_HOST_PATH;
    process.env.NIBI_RUNTIME_HOST_PATH = `${process.cwd()}\\does-not-exist\\nibi-runtime-host.exe`;
    try {
      await expect(resolveWindowsRuntimeHostHelper()).rejects.toThrow(
        /build-windows-runtime-host\.mjs/,
      );
    } finally {
      if (previous === undefined) delete process.env.NIBI_RUNTIME_HOST_PATH;
      else process.env.NIBI_RUNTIME_HOST_PATH = previous;
    }
  });
});
