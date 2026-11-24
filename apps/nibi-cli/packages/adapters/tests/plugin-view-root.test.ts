import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLUGIN_VIEWS_DIR,
  getPluginViewRoot,
  listPluginViewRoots,
  materializePluginViewRoot,
  removePluginViewRoot,
} from "../src/plugins/view-root.js";

// 视图根是 Host 的只读副本：外部插件目录不能被写入，运行时也只读 Host 生成的这份拷贝。
// 这些用例守住三件事：物化产物形状正确、重复调用不产生磁盘抖动、任何 pluginId 都逃不出 views。

const storageRoots: string[] = [];

function makeStorageRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "nibi-view-root-"));
  storageRoots.push(dir);
  return dir;
}

function write(root: string, relativePath: string, content: string): void {
  const path = join(root, ...relativePath.split("/"));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

function makePluginRoot(storage: string, id = "demo"): string {
  const root = join(storage, "source", id.replace(/[@/]/g, "_"));
  mkdirSync(root, { recursive: true });
  return root;
}

function readManifest(viewRoot: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(viewRoot, "manifest.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

function baseInput(input: {
  manifest?: Record<string, unknown>;
  mode?: "copy" | "symlink";
  origin?: string;
  packageHash?: string;
  pluginId?: string;
  rootPath: string;
  storageRoot: string;
  version?: string;
}) {
  return {
    manifest: input.manifest ?? { name: "demo", version: "1.0.0" },
    origin: input.origin ?? "marketplace:nibi-official",
    pluginId: input.pluginId ?? "demo@nibi-official",
    rootPath: input.rootPath,
    storageRoot: input.storageRoot,
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.packageHash ? { packageHash: input.packageHash } : {}),
    ...(input.version ? { version: input.version } : {}),
  };
}

afterEach(() => {
  for (const storage of storageRoots.splice(0)) forceRemove(storage);
});

describe("getPluginViewRoot", () => {
  it("joins views under storage root", () => {
    expect(getPluginViewRoot("/data/nibi/plugins", "demo@nibi-official")).toBe(
      join("/data/nibi/plugins", PLUGIN_VIEWS_DIR, "demo@nibi-official"),
    );
  });

  it("sanitizes plugin ids containing @ and / without escaping views", () => {
    const storage = "/data/nibi/plugins";
    const path = getPluginViewRoot(storage, "@scope/plugin");
    expect(path).toBe(join(storage, PLUGIN_VIEWS_DIR, "@scope-plugin"));
    expect(path.startsWith(join(storage, PLUGIN_VIEWS_DIR))).toBe(true);
    expect(path.includes("..")).toBe(false);
  });

  it("never escapes views for traversal-like ids", () => {
    const storage = "/data/nibi/plugins";
    const viewsRoot = join(storage, PLUGIN_VIEWS_DIR);
    for (const pluginId of ["..", ".", "", "../../etc"]) {
      const path = getPluginViewRoot(storage, pluginId);
      // 结果必须是 views 的直接子目录：父目录严格等于 views。
      expect(join(path, "..")).toBe(viewsRoot);
    }
  });
});

describe("materializePluginViewRoot", () => {
  it("first materialization writes manifest and component copies", async () => {
    const storage = makeStorageRoot();
    const rootPath = makePluginRoot(storage);
    write(rootPath, "skills/demo/SKILL.md", "# demo skill\n");
    write(rootPath, "commands/demo.md", "run demo\n");

    const result = await materializePluginViewRoot(
      baseInput({ rootPath, storageRoot: storage, version: "1.0.0" }),
    );
    expect(result.wrote).toBe(true);
    expect(result.mode).toBe("copy");
    expect(result.viewRoot).toBe(getPluginViewRoot(storage, "demo@nibi-official"));

    const manifest = readManifest(result.viewRoot);
    expect(manifest.name).toBe("demo");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.nibiViewRoot).toEqual({
      origin: "marketplace:nibi-official",
      version: "1.0.0",
    });
    expect(readFileSync(join(result.viewRoot, "skills", "demo", "SKILL.md"), "utf8")).toBe(
      "# demo skill\n",
    );
    expect(readFileSync(join(result.viewRoot, "commands", "demo.md"), "utf8")).toBe(
      "run demo\n",
    );
  });

  it("records packageHash in manifest metadata without overwriting plugin fields", async () => {
    const storage = makeStorageRoot();
    const rootPath = makePluginRoot(storage);

    const result = await materializePluginViewRoot(
      baseInput({
        manifest: {
          description: "demo",
          name: "demo",
          nibiViewRoot: { origin: "spoofed" },
        },
        packageHash: "sha256:abc",
        rootPath,
        storageRoot: storage,
        version: "2.0.0",
      }),
    );

    const manifest = readManifest(result.viewRoot);
    expect(manifest.description).toBe("demo");
    expect(manifest.nibiViewRoot).toEqual({
      origin: "marketplace:nibi-official",
      packageHash: "sha256:abc",
      version: "2.0.0",
    });
  });

  it("is idempotent: same input leaves files byte- and mtime-identical", async () => {
    const storage = makeStorageRoot();
    const rootPath = makePluginRoot(storage);
    write(rootPath, "skills/demo/SKILL.md", "# demo skill\n");
    write(rootPath, "agents/demo.md", "agent\n");

    const input = baseInput({ rootPath, storageRoot: storage });
    const first = await materializePluginViewRoot(input);
    expect(first.wrote).toBe(true);

    const manifestPath = join(first.viewRoot, "manifest.json");
    // 固定一个明显的旧 mtime：只要物化碰了磁盘，mtime 就会变成当前时间。
    const pinned = new Date("2020-01-01T00:00:00.000Z");
    utimesSync(manifestPath, pinned, pinned);
    const pinnedMtimeMs = statSync(manifestPath).mtimeMs;

    const second = await materializePluginViewRoot(input);

    expect(second.wrote).toBe(false);
    expect(second.mode).toBe("copy");
    expect(second.viewRoot).toBe(first.viewRoot);
    expect(statSync(manifestPath).mtimeMs).toBe(pinnedMtimeMs);
  });

  it("rewrites when the manifest changes", async () => {
    const storage = makeStorageRoot();
    const rootPath = makePluginRoot(storage);
    write(rootPath, "skills/demo/SKILL.md", "# v1\n");

    const first = await materializePluginViewRoot(
      baseInput({
        manifest: { name: "demo", version: "1.0.0" },
        rootPath,
        storageRoot: storage,
        version: "1.0.0",
      }),
    );
    expect(first.wrote).toBe(true);
    expect(readManifest(first.viewRoot).version).toBe("1.0.0");

    const second = await materializePluginViewRoot(
      baseInput({
        manifest: { name: "demo", version: "1.0.1" },
        rootPath,
        storageRoot: storage,
        version: "1.0.1",
      }),
    );

    expect(second.wrote).toBe(true);
    expect(readManifest(second.viewRoot).version).toBe("1.0.1");
    expect(readManifest(second.viewRoot).nibiViewRoot).toMatchObject({ version: "1.0.1" });
  });

  it("does not create empty component directories that do not exist in the source", async () => {
    const storage = makeStorageRoot();
    const rootPath = makePluginRoot(storage);

    const result = await materializePluginViewRoot(
      baseInput({ rootPath, storageRoot: storage }),
    );

    expect(result.wrote).toBe(true);
    expect(listFiles(result.viewRoot)).toEqual(["manifest.json"]);
  });

  it("copies hooks/hooks.json as hooks.json", async () => {
    const storage = makeStorageRoot();
    const rootPath = makePluginRoot(storage);
    const hooksBody = '{"PostToolUse":[{"matcher":"*","hooks":[]}]}\n';
    write(rootPath, "hooks/hooks.json", hooksBody);

    const result = await materializePluginViewRoot(
      baseInput({ rootPath, storageRoot: storage }),
    );

    expect(readFileSync(join(result.viewRoot, "hooks.json"), "utf8")).toBe(hooksBody);
  });

  it("writes manifest hooks object as hooks.json when no hooks file exists", async () => {
    const storage = makeStorageRoot();
    const rootPath = makePluginRoot(storage);
    const hooks = { PreToolUse: [{ matcher: "*", hooks: [] }] };

    const result = await materializePluginViewRoot(
      baseInput({
        manifest: { hooks, name: "demo" },
        rootPath,
        storageRoot: storage,
      }),
    );

    expect(JSON.parse(readFileSync(join(result.viewRoot, "hooks.json"), "utf8"))).toEqual(hooks);
  });

  it("symlinks component directories when the platform allows it", async () => {
    const storage = makeStorageRoot();
    const rootPath = makePluginRoot(storage);
    write(rootPath, "skills/demo/SKILL.md", "# from source\n");

    let result: Awaited<ReturnType<typeof materializePluginViewRoot>>;
    try {
      result = await materializePluginViewRoot(
        baseInput({ mode: "symlink", rootPath, storageRoot: storage }),
      );
    } catch {
      // 平台禁止目录链接且回退也失败时才有异常；正常实现两条路径都能成功。
      return;
    }

    // 无论真实链接还是回退复制，视图都必须能读到源文件。
    expect(readFileSync(join(result.viewRoot, "skills", "demo", "SKILL.md"), "utf8")).toBe(
      "# from source\n",
    );
    expect(["copy", "symlink"]).toContain(result.mode);
    if (result.mode === "symlink") {
      expect(lstatSync(join(result.viewRoot, "skills")).isSymbolicLink()).toBe(true);
      // 链接模式下视图直接反映源目录：源里新增的文件应立刻可见。
      write(rootPath, "skills/demo/EXTRA.md", "extra\n");
      expect(
        readFileSync(join(result.viewRoot, "skills", "demo", "EXTRA.md"), "utf8"),
      ).toBe("extra\n");
      // 再次物化同样内容不应重写（链接内容未变）。
      const again = await materializePluginViewRoot(
        baseInput({ mode: "symlink", rootPath, storageRoot: storage }),
      );
      expect(again.wrote).toBe(false);
      expect(again.mode).toBe("symlink");
    } else {
      // 回退复制：视图与源隔离，源里新增的文件不应出现。
      write(rootPath, "skills/demo/EXTRA.md", "extra\n");
      expect(() =>
        readFileSync(join(result.viewRoot, "skills", "demo", "EXTRA.md"), "utf8"),
      ).toThrow();
    }
  });

  it("falls back to copy mode when the platform refuses symlinks", async () => {
    const storage = makeStorageRoot();
    const rootPath = makePluginRoot(storage);
    write(rootPath, "skills/demo/SKILL.md", "# fallback\n");

    // 直接模拟 EPERM：Windows 未开开发者模式、受限容器、网络盘都可能拒绝目录链接，
    // 这条路径必须能在任何平台上确定性地跑到，不能只靠「当前机器恰好不允许」。
    vi.resetModules();
    vi.doMock("node:fs/promises", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs/promises")>();
      return {
        ...actual,
        symlink: async (): Promise<void> => {
          const error = new Error("EPERM: operation not permitted") as NodeJS.ErrnoException;
          error.code = "EPERM";
          throw error;
        },
      };
    });
    try {
      const viewRootModule = await import("../src/plugins/view-root.js");
      const result = await viewRootModule.materializePluginViewRoot(
        baseInput({ mode: "symlink", rootPath, storageRoot: storage }),
      );

      expect(result.mode).toBe("copy");
      expect(result.wrote).toBe(true);
      expect(lstatSync(join(result.viewRoot, "skills")).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(result.viewRoot, "skills", "demo", "SKILL.md"), "utf8")).toBe(
        "# fallback\n",
      );
      // 回退产生的临时目录必须清理干净，不能留下 .tmp-* 残骸。
      expect(
        readdirSync(join(storage, PLUGIN_VIEWS_DIR)).filter((name) => name.includes(".tmp-")),
      ).toEqual([]);
    } finally {
      vi.doUnmock("node:fs/promises");
      vi.resetModules();
    }
  });

  it("skips .git, node_modules and symlinks when copying", async () => {
    const storage = makeStorageRoot();
    const rootPath = makePluginRoot(storage);
    write(rootPath, "skills/demo/SKILL.md", "# demo\n");
    write(rootPath, "skills/demo/.git/config", "[core]\n");
    write(rootPath, "skills/demo/node_modules/pkg/index.js", "module.exports = 1;\n");
    // 插件包外的目录通过链接混进 skills：复制时必须跳过，否则视图会包含不受信任内容。
    const outside = join(storage, "outside");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "outside\n", "utf8");
    try {
      symlinkSync(outside, join(rootPath, "skills", "linked"), "junction");
    } catch {
      // 平台不允许目录链接时这条断言退化为「无链接可跳过」，不影响其余断言。
    }

    const result = await materializePluginViewRoot(
      baseInput({ rootPath, storageRoot: storage }),
    );

    expect(listFiles(join(result.viewRoot, "skills"))).toEqual(["demo/SKILL.md"]);
  });

  it("ignores transient staging directories when listing view roots", async () => {
    const storage = makeStorageRoot();
    const rootPath = makePluginRoot(storage);
    await materializePluginViewRoot(
      baseInput({ pluginId: "demo@nibi-official", rootPath, storageRoot: storage }),
    );
    // 崩溃残留的临时目录不是插件视图，不能出现在列表里污染 UI。
    mkdirSync(
      join(storage, PLUGIN_VIEWS_DIR, "demo@nibi-official.tmp-1234-0b9c1f2e-1111-2222-3333-444455556666"),
      { recursive: true },
    );

    expect(listPluginViewRoots(storage)).toEqual(["demo@nibi-official"]);
  });
});

describe("removePluginViewRoot / listPluginViewRoots", () => {
  it("removes the view root and excludes it from listings", async () => {
    const storage = makeStorageRoot();
    const rootPath = makePluginRoot(storage);
    write(rootPath, "skills/demo/SKILL.md", "# demo\n");

    const result = await materializePluginViewRoot(
      baseInput({ pluginId: "demo@nibi-official", rootPath, storageRoot: storage }),
    );
    expect(listPluginViewRoots(storage)).toEqual(["demo@nibi-official"]);

    expect(removePluginViewRoot(storage, "demo@nibi-official")).toBe(true);
    expect(listPluginViewRoots(storage)).toEqual([]);
    expect(() => lstatSync(result.viewRoot)).toThrow();
  });

  it("returns false when the view root does not exist", () => {
    const storage = makeStorageRoot();
    expect(removePluginViewRoot(storage, "missing@nibi-official")).toBe(false);
  });

  it("returns an empty list when views has never been materialized", () => {
    expect(listPluginViewRoots(makeStorageRoot())).toEqual([]);
  });
});

function listFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (directory: string, prefix: string): void => {
    for (const entry of readdirNames(directory)) {
      const relative = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(join(directory, entry)).isDirectory()) {
        visit(join(directory, entry), relative);
        continue;
      }
      out.push(relative);
    }
  };
  visit(root, "");
  return out.sort();
}

function readdirNames(directory: string): string[] {
  return readdirSync(directory);
}

/** 只读用例收尾：物化会把文件设成 0444，删除前先恢复可写，避免 Windows 只读属性拖累清理。 */
function forceRemove(storage: string): void {
  for (const name of listPluginViewRoots(storage)) {
    const viewRoot = join(storage, PLUGIN_VIEWS_DIR, name);
    makeTreeWritable(viewRoot);
    removePluginViewRoot(storage, name);
  }
  makeTreeWritable(storage);
  rmSync(storage, { force: true, maxRetries: 3, recursive: true, retryDelay: 25 });
}

function makeTreeWritable(path: string): void {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    for (const entry of readdirSync(path)) makeTreeWritable(join(path, entry));
    try {
      chmodSync(path, 0o755);
    } catch {
      // Windows/受限 FS 上无意义。
    }
    return;
  }
  try {
    chmodSync(path, 0o644);
  } catch {
    // 同上。
  }
}
