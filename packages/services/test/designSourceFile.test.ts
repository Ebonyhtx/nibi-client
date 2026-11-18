import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFileService } from "../src/file/fileService.js";
import type { IFileService } from "../src/file/file.js";

// 设计工具写回本地 HTML 的 Host 侧边界：workspace 约束、严格 UTF-8、大小上限、
// expected-content 校验与原子写入。宁可不写，也不能写到 workspace 外或覆盖别人的改动。

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createWorkspace(): { root: string; service: IFileService } {
  return { root: makeTempDir("nibi-design-source-"), service: createFileService() };
}

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("FileService design source read/write", () => {
  it("reads an HTML file inside the workspace byte-for-byte", async () => {
    const { root, service } = createWorkspace();
    const page = join(root, "index.html");
    const source = '<!doctype html>\r\n<html><body><p style="color: red">你好</p></body></html>\n';
    writeFileSync(page, source);

    await expect(
      service.readDesignSourceFile({ workspacePath: root, path: page }),
    ).resolves.toEqual({ content: source });
  });

  it("rejects paths outside the workspace, including directory links", async () => {
    const { root, service } = createWorkspace();
    const outside = makeTempDir("nibi-design-outside-");
    const outsidePage = join(outside, "page.html");
    writeFileSync(outsidePage, "<html></html>");

    await expect(
      service.readDesignSourceFile({ workspacePath: root, path: outsidePage }),
    ).rejects.toThrow(/outside the workspace/u);

    const linkPath = join(root, "linked-outside");
    symlinkSync(outside, linkPath, process.platform === "win32" ? "junction" : "dir");
    await expect(
      service.readDesignSourceFile({ workspacePath: root, path: join(linkPath, "page.html") }),
    ).rejects.toThrow(/outside the workspace/u);

    // 写入同样不能借越界路径改文件。
    await expect(
      service.writeDesignSourceFile({
        workspacePath: root,
        path: outsidePage,
        expectedContent: "<html></html>",
        content: "<html><body>evil</body></html>",
      }),
    ).rejects.toThrow(/outside the workspace/u);
    expect(readText(outsidePage)).toBe("<html></html>");
  });

  it("accepts only .html/.htm and enforces the 4 MB read cap", async () => {
    const { root, service } = createWorkspace();
    const textFile = join(root, "notes.txt");
    writeFileSync(textFile, "hello");
    await expect(
      service.readDesignSourceFile({ workspacePath: root, path: textFile }),
    ).rejects.toThrow(/must be an HTML file/u);

    const hugePage = join(root, "huge.html");
    writeFileSync(hugePage, Buffer.alloc(4 * 1024 * 1024 + 1, 0x61));
    await expect(
      service.readDesignSourceFile({ workspacePath: root, path: hugePage }),
    ).rejects.toThrow(/too large|not a readable HTML file/u);
  });

  it("rejects invalid UTF-8 instead of silently corrupting it on a later write", async () => {
    const { root, service } = createWorkspace();
    const invalidPage = join(root, "gbk.html");
    writeFileSync(invalidPage, Buffer.from([0x3c, 0x70, 0x3e, 0xd6, 0xd0, 0x3c, 0x2f, 0x70, 0x3e]));

    await expect(
      service.readDesignSourceFile({ workspacePath: root, path: invalidPage }),
    ).rejects.toThrow(/not valid UTF-8/u);
  });

  it("writes only when expectedContent still matches and leaves no temp files", async () => {
    const { root, service } = createWorkspace();
    const page = join(root, "index.html");
    const before = "<html><body><p>old</p></body></html>";
    writeFileSync(page, before);

    await expect(
      service.writeDesignSourceFile({
        workspacePath: root,
        path: page,
        expectedContent: "<html><body><p>stale</p></body></html>",
        content: "<html><body><p>new</p></body></html>",
      }),
    ).resolves.toEqual({ written: false });
    expect(readText(page)).toBe(before);

    await expect(
      service.writeDesignSourceFile({
        workspacePath: root,
        path: page,
        expectedContent: before,
        content: "<html><body><p>new</p></body></html>",
      }),
    ).resolves.toEqual({ written: true });
    expect(readText(page)).toBe("<html><body><p>new</p></body></html>");
    expect(readdirSync(root).filter((name) => name.includes(".nibi-tmp"))).toEqual([]);
  });

  it("serializes concurrent writes so the second expected-content check sees the first result", async () => {
    const { root, service } = createWorkspace();
    const page = join(root, "index.html");
    const before = "<html><body>0</body></html>";
    writeFileSync(page, before);

    const results = await Promise.all([
      service.writeDesignSourceFile({
        workspacePath: root,
        path: page,
        expectedContent: before,
        content: "<html><body>1</body></html>",
      }),
      service.writeDesignSourceFile({
        workspacePath: root,
        path: page,
        expectedContent: before,
        content: "<html><body>2</body></html>",
      }),
    ]);

    expect(results.filter((result) => result.written)).toHaveLength(1);
    expect(["<html><body>1</body></html>", "<html><body>2</body></html>"]).toContain(
      readText(page),
    );
  });

  it("refuses oversized replacement content before touching the file", async () => {
    const { root, service } = createWorkspace();
    const page = join(root, "index.html");
    writeFileSync(page, "<html></html>");

    await expect(
      service.writeDesignSourceFile({
        workspacePath: root,
        path: page,
        expectedContent: "<html></html>",
        content: "x".repeat(4 * 1024 * 1024 + 1),
      }),
    ).rejects.toThrow(/too large/u);
    expect(readText(page)).toBe("<html></html>");
  });
});
