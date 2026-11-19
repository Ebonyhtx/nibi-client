import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildRuntimeHost,
  isRuntimeHostReady,
} from "../scripts/build-windows-runtime-host.mjs";
import {
  isWindowsInstallerProcessHelperMissingError,
  runWindowsInstallerProcessHelper,
} from "../src/main/windowsInstallResourceLocks.js";

const desktopDir = join(import.meta.dirname, "..");
const helperName = "nibi-installer-process-helper.exe";

interface HelperMatch {
  pid: number;
  created: string;
  path: string;
  canTerminate: boolean;
}

interface HelperResult {
  version: number;
  mode: string;
  status: string;
  exitCode: number;
  matches: HelperMatch[];
  remaining: HelperMatch[];
  denied: Array<{ pid: number; win32: number }>;
}

interface HelperRun {
  code: number;
  stdout: string;
  stderr: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWindowsPath(value: string): string {
  return value.replaceAll("/", "\\").toLowerCase();
}

describe.skipIf(process.platform !== "win32")(
  "Windows installer process helper",
  () => {
    let helperDir: string | undefined;
    let helperPath = "";
    let root = "";
    const children: ChildProcess[] = [];

    const runHelper = (
      args: string[],
      env: NodeJS.ProcessEnv = process.env,
    ): HelperRun => {
      const result = spawnSync(helperPath, args, {
        encoding: "utf8",
        env,
        timeout: 30_000,
        windowsHide: true,
      });
      if (result.error) {
        throw result.error;
      }
      return {
        code: result.status ?? -1,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      };
    };

    const parseResult = (run: HelperRun): HelperResult =>
      JSON.parse(run.stdout.trim()) as HelperResult;

    const copyNodeExecutable = (path: string) => {
      mkdirSync(dirname(path), { recursive: true });
      copyFileSync(process.execPath, path);
    };

    const spawnTarget = (
      executable: string,
      args: string[] = ["-e", "setInterval(() => {}, 1000)"],
    ): ChildProcess => {
      const child = spawn(executable, args, {
        stdio: "ignore",
        windowsHide: true,
      });
      children.push(child);
      return child;
    };

    const waitForMatch = async (
      target: string,
      pid: number,
    ): Promise<HelperResult> => {
      for (let attempt = 0; attempt < 60; ++attempt) {
        const result = parseResult(
          runHelper(["--check", "--json", "--target", target]),
        );
        if (result.matches.some((match) => match.pid === pid)) {
          return result;
        }
        await delay(50);
      }
      throw new Error(`helper did not match target pid ${pid}: ${target}`);
    };

    beforeAll(async () => {
      if (process.arch !== "x64" && process.arch !== "arm64") {
        throw new Error(`Unsupported test architecture: ${process.arch}`);
      }
      const bundled = join(
        desktopDir,
        "bundled-tools",
        `win32-${process.arch}`,
        "runtime-host",
      );
      if (await isRuntimeHostReady(bundled, process.arch)) {
        helperDir = bundled;
      } else {
        helperDir = mkdtempSync(join(tmpdir(), "nibi-installer-helper-build-"));
        await buildRuntimeHost({ arch: process.arch, outputDir: helperDir });
      }
      helperPath = join(helperDir, helperName);
      root = realpathSync.native(
        mkdtempSync(join(tmpdir(), "nibi-installer-helper-test-")),
      );
    }, 240_000);

    afterEach(() => {
      while (children.length > 0) {
        const child = children.pop();
        if (child && child.exitCode === null) {
          child.kill();
        }
      }
    });

    afterAll(() => {
      if (root) {
        rmSync(root, { recursive: true, force: true });
      }
      if (helperDir && helperDir.startsWith(tmpdir())) {
        rmSync(helperDir, { recursive: true, force: true });
      }
    });

    it("surfaces a missing helper as an explicit fallback signal", async () => {
      let error: unknown;
      try {
        await runWindowsInstallerProcessHelper({
          helperPath: join(root, "missing-helper.exe"),
          mode: "check",
          targets: [join(root, "nibi-rs.exe")],
          timeoutMs: 5000,
        });
      } catch (caught) {
        error = caught;
      }
      expect(isWindowsInstallerProcessHelperMissingError(error)).toBe(true);
    });

    it("matches only the exact executable path, case-insensitively", async () => {
      const exactPath = join(root, "exact", "nibi-target.exe");
      const sameNamePath = join(root, "same-name", "nibi-target.exe");
      const suffixPath = `${exactPath}.backup`;
      const commandLineOnlyPath = join(root, "command-line-only", "unrelated.exe");
      copyNodeExecutable(exactPath);
      copyNodeExecutable(sameNamePath);
      copyNodeExecutable(suffixPath);
      copyNodeExecutable(commandLineOnlyPath);

      const exact = spawnTarget(exactPath);
      const sameName = spawnTarget(sameNamePath);
      const suffix = spawnTarget(suffixPath);
      // The target path appears in this process command line, but its image path
      // is a different executable and must not become a match.
      const commandLineOnly = spawnTarget(commandLineOnlyPath, [
        "-e",
        "setInterval(() => {}, 1000)",
        exactPath,
      ]);
      expect(exact.pid).toBeTypeOf("number");
      expect(sameName.pid).toBeTypeOf("number");
      expect(suffix.pid).toBeTypeOf("number");
      expect(commandLineOnly.pid).toBeTypeOf("number");

      await waitForMatch(exactPath, exact.pid!);
      await waitForMatch(sameNamePath, sameName.pid!);
      await waitForMatch(suffixPath, suffix.pid!);
      await waitForMatch(commandLineOnlyPath, commandLineOnly.pid!);

      const normalizedTarget = exactPath.toUpperCase().replaceAll("\\", "/");
      const matched = runHelper([
        "--check",
        "--json",
        "--target",
        normalizedTarget,
      ]);
      const normalized = parseResult(matched);
      expect(matched.code).toBe(2);
      expect(normalized.status).toBe("blocked");
      expect(normalized.matches.map((match) => match.pid)).toEqual([exact.pid]);
      expect(normalized.matches.map((match) => match.pid)).not.toContain(
        commandLineOnly.pid,
      );
      expect(normalized.matches[0].created).toMatch(/^[1-9]\d+$/);
      expect(normalizeWindowsPath(normalized.matches[0].path)).toBe(
        normalizeWindowsPath(exactPath),
      );

      // Parent directory, prefix without the extension, and the sibling copy
      // with the same image name must never become substring matches.
      for (const notATarget of [
        join(root, "exact"),
        exactPath.slice(0, -".exe".length),
        sameNamePath,
      ]) {
        const result = runHelper([
          "--check",
          "--json",
          "--target",
          notATarget,
        ]);
        expect(result.code).toBe(notATarget === sameNamePath ? 2 : 0);
        const parsed = parseResult(result);
        if (notATarget === sameNamePath) {
          expect(parsed.matches.map((match) => match.pid)).toEqual([
            sameName.pid,
          ]);
        } else {
          expect(parsed.matches).toEqual([]);
        }
      }
    });

    it("rejects a process when the repeated creation-time check differs", async () => {
      const exactPath = join(root, "recheck", "nibi-target.exe");
      copyNodeExecutable(exactPath);
      const child = spawnTarget(exactPath);
      await waitForMatch(exactPath, child.pid!);

      const normal = runHelper(["--check", "--json", "--target", exactPath]);
      expect(normal.code).toBe(2);

      const mismatched = runHelper([
        "--check",
        "--json",
        "--test-force-recheck-mismatch",
        "--target",
        exactPath,
      ]);
      expect(mismatched.code).toBe(0);
      expect(parseResult(mismatched).matches).toEqual([]);
    });

    it("terminates the exact target and waits without touching same-name processes", async () => {
      const exactPath = join(root, "terminate", "nibi-target.exe");
      const sameNamePath = join(root, "terminate-same-name", "nibi-target.exe");
      copyNodeExecutable(exactPath);
      copyNodeExecutable(sameNamePath);

      const exact = spawnTarget(exactPath);
      const sameName = spawnTarget(sameNamePath);
      await waitForMatch(exactPath, exact.pid!);
      await waitForMatch(sameNamePath, sameName.pid!);

      const terminated = runHelper([
        "--terminate",
        "--wait-ms",
        "5000",
        "--json",
        "--target",
        exactPath,
      ]);
      const parsed = parseResult(terminated);
      expect(terminated.code).toBe(0);
      expect(parsed.status).toBe("closed");
      expect(parsed.remaining).toEqual([]);
      expect(parsed.matches.map((match) => match.pid)).toEqual([exact.pid]);

      for (let attempt = 0; attempt < 60 && exact.exitCode === null; ++attempt) {
        await delay(50);
      }
      expect(exact.exitCode).not.toBeNull();
      expect(sameName.exitCode).toBeNull();
    });
  },
);
