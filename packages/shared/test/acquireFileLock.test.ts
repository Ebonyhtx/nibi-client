import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireFileLock } from "../src/node.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("acquireFileLock", () => {
  it("父目录不存在时自建：新装/隔离数据根的第一次加锁不能 ENOENT", async () => {
    const root = mkdtempSync(join(tmpdir(), "nibi-lock-parent-"));
    roots.push(root);
    const filePath = join(root, ".nibi", "v2", "credentials.json");

    const release = await acquireFileLock(filePath, [10, 20], 10, 1_000);
    expect(statSync(`${filePath}.lock`).isDirectory()).toBe(true);
    await release();
    expect(() => statSync(`${filePath}.lock`)).toThrow();
  });
});
