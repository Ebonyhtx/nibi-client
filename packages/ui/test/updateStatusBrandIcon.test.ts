import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("update dialog brand icon", () => {
  it("uses the same NIBI app icon as the desktop build", () => {
    // UpdateStatusDialog 直接引用 public/icon_512@2x.png；它曾残留上游 Z 图标。
    expect(fileHash(resolve(repoRoot, "public/icon_512@2x.png"))).toBe(
      fileHash(resolve(repoRoot, "packages/desktop/build/icon.png")),
    );
  });
});
