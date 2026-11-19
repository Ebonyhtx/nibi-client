import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const MANIFEST_PATH = resolve(REPO_ROOT, "packages/desktop/build/brand/icon-manifest.json");

interface ManifestFile {
  path: string;
  kind: "png" | "ico" | "icns";
  width?: number;
  height?: number;
  sizes?: number[];
  sha256: string;
}

interface IconManifest {
  version: number;
  source: string;
  sourceSha256: string;
  generator: string;
  forbiddenSha256: Array<{ sha256: string; reason: string }>;
  files: ManifestFile[];
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as IconManifest;

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function pngSize(buffer: Buffer): { width: number; height: number } {
  // PNG signature (8 bytes) followed by IHDR length/type; width at 16, height at 20.
  expect(buffer.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function icoEntries(buffer: Buffer): number {
  expect(buffer.readUInt16LE(0)).toBe(0);
  expect(buffer.readUInt16LE(2)).toBe(1);
  return buffer.readUInt16LE(4);
}

function icnsLength(buffer: Buffer): number {
  expect(buffer.subarray(0, 4).toString("ascii")).toBe("icns");
  return buffer.readUInt32BE(4);
}

describe("NIBI shipping icon manifest", () => {
  it("pins the official NIBI source asset", () => {
    expect(manifest.version).toBe(1);
    expect(manifest.source).toBe("packages/ui/src/assets/nibi/nibi-app-icon.png");
    const sourcePath = resolve(REPO_ROOT, manifest.source);
    expect(existsSync(sourcePath)).toBe(true);
    expect(sha256(sourcePath)).toBe(manifest.sourceSha256);
    // The official NIBI app icon (same bytes as the Private brand preview).
    expect(manifest.sourceSha256).toBe(
      "92db501cbd112ddac8c750011cb55f33b6ebbcdfee95b0cc614dd7de145bcd7a",
    );
    expect(pngSize(readFileSync(sourcePath))).toEqual({ width: 1024, height: 1024 });
  });

  it("covers every shipping icon surface", () => {
    const paths = new Set(manifest.files.map((file) => file.path));
    for (const required of [
      "packages/desktop/build/icon.png",
      "packages/desktop/build/icon_windows.png",
      "packages/desktop/build/icon_macos_1024.png",
      "packages/desktop/build/icon_installer.png",
      "packages/desktop/build/icon.ico",
      "packages/desktop/build/icon_installer.ico",
      "packages/desktop/build/icon.icns",
      "packages/desktop/build/icon_installer.icns",
      "packages/desktop/build/icons/16x16.png",
      "packages/desktop/build/icons/512x512.png",
      "packages/desktop/build/icons/1024x1024.png",
      "packages/desktop/src/renderer/public/nibi-app-icon.png",
    ]) {
      expect(paths.has(required), required).toBe(true);
    }
  });

  it("matches every tracked icon byte-for-byte and never uses upstream artwork", () => {
    const forbidden = new Set(manifest.forbiddenSha256.map((entry) => entry.sha256));
    for (const file of manifest.files) {
      const absolute = resolve(REPO_ROOT, file.path);
      expect(existsSync(absolute), file.path).toBe(true);
      const buffer = readFileSync(absolute);
      const digest = createHash("sha256").update(buffer).digest("hex");
      expect(digest, file.path).toBe(file.sha256);
      expect(forbidden.has(digest), `${file.path} is forbidden upstream artwork`).toBe(false);

      if (file.kind === "png") {
        expect(pngSize(buffer), file.path).toEqual({
          width: file.width,
          height: file.height,
        });
      } else if (file.kind === "ico") {
        expect(icoEntries(buffer), file.path).toBe(file.sizes?.length);
      } else {
        expect(icnsLength(buffer), file.path).toBe(buffer.length);
      }
    }
  });
});
