import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createNodeClipboardImageReader } from "../src/clipboard-image.js";

test("image clipboard reader uses the NIBI storage root for native temp files", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "zcode-clipboard-storage-root-"));
  const imagePaths: string[] = [];
  const readClipboardImage = createNodeClipboardImageReader({
    platform: "darwin",
    processEnv: {
      ...process.env,
      NIBI_STORAGE_DIR: storageRoot,
    },
    runCommand: async (_file, args) => {
      const scriptLine = args.find((arg) => arg.includes("clipboard.png")) ?? "";
      const match = scriptLine.match(/POSIX file "([^"]+)"/);
      // AppleScript 字符串里的反斜杠是转义的；Windows 宿主上 join() 会给出带 `\` 的路径。
      const imagePath = match?.[1]?.replace(/\\\\/gu, "\\").replace(/\\"/gu, '"');
      if (!imagePath) {
        return { exitCode: 1, stdout: Buffer.alloc(0) };
      }
      imagePaths.push(imagePath);
      await writeFile(imagePath, Buffer.from("png-data"));
      return { exitCode: 0, stdout: Buffer.alloc(0) };
    },
  });

  try {
    const image = await readClipboardImage();
    assert.equal(image?.mediaType, "image/png");
    assert.match(
      imagePaths[0] ?? "",
      new RegExp(`^${escapeRegExp(join(storageRoot, "clipboard", "nibi-clipboard-"))}`),
    );
    assert.deepEqual(await readdir(join(storageRoot, "clipboard")), []);
  } finally {
    await rm(storageRoot, { force: true, recursive: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
