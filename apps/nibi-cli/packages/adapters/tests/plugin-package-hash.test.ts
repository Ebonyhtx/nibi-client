import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLUGIN_PACKAGE_HASH_PREFIX,
  PluginPackageHashError,
  computePluginPackageHash,
  isPluginPackageHash,
} from "../src/plugins/package-hash.js";

const roots: string[] = [];

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function write(root: string, relativePath: string, content: string): void {
  const path = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("computePluginPackageHash", () => {
  it("returns a canonical sha256 hash with the expected prefix", () => {
    const root = makeRoot("nibi-hash-format-");
    write(root, "plugin.json", '{"name":"demo"}');

    const hash = computePluginPackageHash(root);

    expect(hash.startsWith(PLUGIN_PACKAGE_HASH_PREFIX)).toBe(true);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(isPluginPackageHash(hash)).toBe(true);
    expect(isPluginPackageHash("sha256:not-hex")).toBe(false);
    expect(isPluginPackageHash("md5:abc")).toBe(false);
  });

  it("is independent of file creation order and mtime", () => {
    const first = makeRoot("nibi-hash-order-a-");
    write(first, "b.txt", "bravo");
    write(first, "a.txt", "alpha");
    write(first, "nested/c.txt", "charlie");

    const second = makeRoot("nibi-hash-order-b-");
    write(second, "nested/c.txt", "charlie");
    write(second, "a.txt", "alpha");
    write(second, "b.txt", "bravo");

    const baseline = computePluginPackageHash(first);
    expect(computePluginPackageHash(second)).toBe(baseline);

    utimesSync(join(first, "a.txt"), new Date(1_000), new Date(1_000));
    expect(computePluginPackageHash(first)).toBe(baseline);
  });

  it("changes when a file is modified, added, removed or renamed", () => {
    const root = makeRoot("nibi-hash-change-");
    write(root, "a.txt", "alpha");
    write(root, "b.txt", "bravo");
    const original = computePluginPackageHash(root);

    write(root, "a.txt", "alpha!");
    const modified = computePluginPackageHash(root);
    expect(modified).not.toBe(original);

    write(root, "c.txt", "charlie");
    const added = computePluginPackageHash(root);
    expect(added).not.toBe(modified);

    unlinkSync(join(root, "c.txt"));
    expect(computePluginPackageHash(root)).toBe(modified);

    const beforeRename = computePluginPackageHash(root);
    // 改名会改变相对路径 → hash 必须变化。
    write(root, "renamed.txt", "bravo");
    unlinkSync(join(root, "b.txt"));
    expect(computePluginPackageHash(root)).not.toBe(beforeRename);
  });

  it("ignores .git, node_modules/.cache, .DS_Store, Thumbs.db and *.tmp", () => {
    const root = makeRoot("nibi-hash-ignored-");
    write(root, "plugin.json", '{"name":"demo"}');
    const baseline = computePluginPackageHash(root);

    write(root, ".git/config", "noise");
    write(root, ".git/objects/info", "noise");
    write(root, "node_modules/.cache/build.json", "noise");
    write(root, "node_modules/pkg/index.js", "real dependency");
    write(root, ".DS_Store", "noise");
    write(root, "Thumbs.db", "noise");
    write(root, "scratch.tmp", "noise");

    // node_modules 本身参与 hash，只有 .cache 被跳过。
    const withDependency = computePluginPackageHash(root);
    expect(withDependency).not.toBe(baseline);

    unlinkSync(join(root, "node_modules", "pkg", "index.js"));
    expect(computePluginPackageHash(root)).toBe(baseline);
  });

  it("counts symlink target strings without following them", () => {
    const outside = makeRoot("nibi-hash-outside-");
    writeFileSync(join(outside, "target.txt"), "one", "utf8");
    const root = makeRoot("nibi-hash-symlink-");
    write(root, "a.txt", "alpha");
    try {
      symlinkSync(join(outside, "target.txt"), join(root, "link.txt"), "file");
    } catch {
      // Windows 未启用开发者模式时无法创建符号链接；跳过该用例。
      return;
    }
    const linked = computePluginPackageHash(root);

    // 修改链接指向的外部内容不应改变包 hash（不跟随链接）。
    writeFileSync(join(outside, "target.txt"), "two", "utf8");
    expect(computePluginPackageHash(root)).toBe(linked);

    // 删除链接条目本身会改变清单。
    unlinkSync(join(root, "link.txt"));
    const unlinked = computePluginPackageHash(root);
    expect(unlinked).not.toBe(linked);

    // 链接目标字符串变化会改变 hash。
    writeFileSync(join(outside, "other.txt"), "two", "utf8");
    symlinkSync(join(outside, "other.txt"), join(root, "link.txt"), "file");
    expect(computePluginPackageHash(root)).not.toBe(unlinked);
  });

  it("throws PluginPackageHashError when maxFiles is exceeded", () => {
    const root = makeRoot("nibi-hash-maxfiles-");
    write(root, "a.txt", "a");
    write(root, "b.txt", "b");

    let thrown: unknown;
    try {
      computePluginPackageHash(root, { maxFiles: 1 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PluginPackageHashError);
    expect((thrown as PluginPackageHashError).code).toBe("too_large");
  });

  it("throws PluginPackageHashError when maxBytes is exceeded", () => {
    const root = makeRoot("nibi-hash-maxbytes-");
    write(root, "a.txt", "0123456789");

    let thrown: unknown;
    try {
      computePluginPackageHash(root, { maxBytes: 4 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PluginPackageHashError);
    expect((thrown as PluginPackageHashError).code).toBe("too_large");
  });

  it("does not count ignored noise toward limits", () => {
    const root = makeRoot("nibi-hash-limits-ignore-");
    write(root, "a.txt", "a");
    write(root, ".DS_Store", "noise");

    expect(() => computePluginPackageHash(root, { maxFiles: 1 })).not.toThrow();
  });
});
