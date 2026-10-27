import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { replaceFileWithRetry } from "../src/runtime/statusSnapshot.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function renameError(code: string): Error & { code: string } {
  return Object.assign(new Error(`rename failed: ${code}`), { code });
}

describe("replaceFileWithRetry", () => {
  it("retries the Windows transient codes and then succeeds", async () => {
    const attempted: string[] = [];
    const rename = async () => {
      const code = attempted.length === 0 ? "EPERM" : attempted.length === 1 ? "EBUSY" : "";
      attempted.push(code || "ok");
      if (code) throw renameError(code);
    };

    await replaceFileWithRetry("temporary", "target", {
      delayMs: 0,
      rename: rename as never,
    });

    expect(attempted).toEqual(["EPERM", "EBUSY", "ok"]);
  });

  it("does not retry non-transient errors", async () => {
    let calls = 0;
    const rename = async () => {
      calls += 1;
      throw renameError("ENOENT");
    };

    await expect(
      replaceFileWithRetry("temporary", "target", { delayMs: 0, rename: rename as never }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toBe(1);
  });

  it("gives up after the retry budget", async () => {
    let calls = 0;
    const rename = async () => {
      calls += 1;
      throw renameError("EBUSY");
    };

    await expect(
      replaceFileWithRetry("temporary", "target", {
        delayMs: 0,
        rename: rename as never,
        retries: 2,
      }),
    ).rejects.toMatchObject({ code: "EBUSY" });
    expect(calls).toBe(3);
  });

  it("atomically replaces an existing snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "status-snapshot-replace-"));
    directories.push(directory);
    const target = join(directory, "status.json");
    const temporary = join(directory, "status.json.tmp");
    await writeFile(target, '{"state":"old"}\n', "utf8");
    await writeFile(temporary, '{"state":"new"}\n', "utf8");

    await replaceFileWithRetry(temporary, target);

    await expect(readFile(target, "utf8")).resolves.toBe('{"state":"new"}\n');
  });
});
