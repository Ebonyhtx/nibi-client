import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/main/autoUpdater.js", () => ({
  installReadyUpdate: vi.fn(),
  requestForceAutoUpdate: vi.fn(),
}));
vi.mock("../src/main/forceUpdatePrompt.js", () => ({
  showForceUpdatePrompt: vi.fn(),
}));

import {
  FORCE_UPDATE_LKG_FILENAME,
  FORCE_UPDATE_LKG_MAX_AGE_MS,
  readForceUpdateLkg,
  writeForceUpdateLkg,
} from "../src/main/forceUpdateLkg.js";

const logger = { info: () => undefined, warn: () => undefined };

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "nibi-force-update-lkg-"));
}

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function makeTemp(): Promise<string> {
  const directory = await tempDir();
  directories.push(directory);
  return directory;
}

describe("force update LKG", () => {
  it("successful config writes the last good minimal version", async () => {
    const directory = await makeTemp();
    const { resolveDesktopForceUpdateRequirement } = await import(
      "../src/main/forceUpdateGuard.js"
    );

    const requirement = await resolveDesktopForceUpdateRequirement({
      logger,
      fetchRemoteConfig: async () => ({
        code: 0,
        data: { configs: { forceUpdate: { minimalVersion: "999.0.0" } } },
      }),
      lkgDirectory: directory,
      now: () => 1_000,
    });

    expect(requirement?.minimalVersion).toBe("999.0.0");
    await expect(readForceUpdateLkg(directory, 1_001)).resolves.toEqual({
      minimalVersion: "999.0.0",
      fetchedAt: 1_000,
      fresh: true,
    });
  });

  it("a fresh LKG enforces the last known minimum when the network fails", async () => {
    const directory = await makeTemp();
    await writeForceUpdateLkg(directory, "999.0.0", 1_000);
    const { resolveDesktopForceUpdateRequirement } = await import(
      "../src/main/forceUpdateGuard.js"
    );

    const requirement = await resolveDesktopForceUpdateRequirement({
      logger,
      fetchRemoteConfig: async () => {
        throw new Error("offline");
      },
      lkgDirectory: directory,
      now: () => 2_000,
    });

    expect(requirement?.minimalVersion).toBe("999.0.0");
  });

  it("a stale LKG does not block startup", async () => {
    const directory = await makeTemp();
    const now = FORCE_UPDATE_LKG_MAX_AGE_MS + 10_000;
    await writeForceUpdateLkg(directory, "999.0.0", 1_000);
    const { resolveDesktopForceUpdateRequirement } = await import(
      "../src/main/forceUpdateGuard.js"
    );

    const requirement = await resolveDesktopForceUpdateRequirement({
      logger,
      fetchRemoteConfig: async () => {
        throw new Error("offline");
      },
      lkgDirectory: directory,
      now: () => now,
    });

    expect(requirement).toBeNull();
  });

  it("no LKG keeps the existing offline fail-open behaviour", async () => {
    const directory = await makeTemp();
    const { resolveDesktopForceUpdateRequirement } = await import(
      "../src/main/forceUpdateGuard.js"
    );

    const requirement = await resolveDesktopForceUpdateRequirement({
      logger,
      fetchRemoteConfig: async () => {
        throw new Error("offline");
      },
      lkgDirectory: directory,
      now: () => 1_000,
    });

    expect(requirement).toBeNull();
  });

  it("a malformed LKG file is ignored", async () => {
    const directory = await makeTemp();
    await writeFile(join(directory, FORCE_UPDATE_LKG_FILENAME), "{not-json", "utf8");
    const { resolveDesktopForceUpdateRequirement } = await import(
      "../src/main/forceUpdateGuard.js"
    );

    const requirement = await resolveDesktopForceUpdateRequirement({
      logger,
      fetchRemoteConfig: async () => {
        throw new Error("offline");
      },
      lkgDirectory: directory,
      now: () => 1_000,
    });

    expect(requirement).toBeNull();
  });

  it("a successful response without a minimum records null and does not block", async () => {
    const directory = await makeTemp();
    const { resolveDesktopForceUpdateRequirement } = await import(
      "../src/main/forceUpdateGuard.js"
    );

    const requirement = await resolveDesktopForceUpdateRequirement({
      logger,
      fetchRemoteConfig: async () => ({ code: 0, data: { configs: {} } }),
      lkgDirectory: directory,
      now: () => 1_000,
    });

    expect(requirement).toBeNull();
    const stored = JSON.parse(
      await readFile(join(directory, FORCE_UPDATE_LKG_FILENAME), "utf8"),
    ) as { minimalVersion: string | null };
    expect(stored.minimalVersion).toBeNull();
  });
});
