import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodePluginAdapter } from "../src/plugins/index.js";

async function discover(rootPath: string, options: { official?: boolean } = {}) {
  const storageRoot = join(rootPath, ".storage");
  return createNodePluginAdapter({ storageRoot }).discoverPlugins({
    config: {
      dirs: options.official ? [] : [rootPath],
      enabled: true,
      enabledPlugins: {},
      options: {},
      suppressedBuiltins: [],
    },
    env: {},
    ...(options.official ? { officialPluginRoots: [rootPath] } : {}),
    storageRoot,
    workingDirectory: rootPath,
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value));
}

describe("canonical plugin adapter", () => {
  it("flattens a NIBI extension and reports declared permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nibi-canonical-native-"));
    try {
      await writeJson(join(dir, "plugin.json"), {
        name: "native-one",
        version: "1.0.0",
        description: "Native fixture",
        extensions: {
          "com.nibistudio.nibi": {
            skills: "skills",
            permissions: ["filesystem.read", "network", "not.a.permission"],
            settings: { theme: "light" },
          },
        },
      });

      const outcome = await discover(dir);
      expect(outcome.plugins).toHaveLength(1);
      expect(outcome.plugins[0]).toMatchObject({
        adapter: {
          adapterId: "native",
          compatibility: "partial",
          manifestPath: "plugin.json",
          skipped: ["settings"],
        },
        description: "Native fixture",
        permissions: { requested: ["filesystem.read", "network"] },
        trust: "local",
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("classifies an extension-free root manifest as generic Agent Plugins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nibi-canonical-agent-"));
    try {
      await writeJson(join(dir, "plugin.json"), {
        name: "agent-plugins-one",
        version: "1.0.0",
      });

      const outcome = await discover(dir);
      expect(outcome.plugins[0]?.adapter).toEqual({
        adapterId: "agent-plugins",
        compatibility: "full",
        manifestPath: "plugin.json",
        skipped: [],
      });
      expect(outcome.plugins[0]?.trust).toBe("local");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("classifies a root Codex extension and records unsupported connectors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nibi-canonical-codex-"));
    try {
      await writeJson(join(dir, "plugin.json"), {
        name: "codex-one",
        version: "1.0.0",
        apps: { example: {} },
        extensions: { "com.openai": { connectors: [] } },
      });

      const outcome = await discover(dir);
      expect(outcome.plugins[0]?.adapter).toMatchObject({
        adapterId: "codex",
        compatibility: "partial",
        skipped: ["apps"],
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("reads Claude and ZCode manifests through their own adapters", async () => {
    const claude = await mkdtemp(join(tmpdir(), "nibi-canonical-claude-"));
    const zcode = await mkdtemp(join(tmpdir(), "nibi-canonical-zcode-"));
    try {
      await writeJson(join(claude, ".claude-plugin", "plugin.json"), {
        name: "claude-one",
        version: "1.0.0",
        commands: "commands",
      });
      await publishMarker(join(claude, "commands"));

      await writeJson(join(zcode, ".zcode-plugin", "plugin.json"), {
        name: "zcode-one",
        version: "1.0.0",
        skills: "skills",
      });
      await publishMarker(join(zcode, "skills"));

      const claudeOutcome = await discover(claude);
      expect(claudeOutcome.plugins[0]?.adapter).toMatchObject({
        adapterId: "claude",
        manifestPath: ".claude-plugin/plugin.json",
      });

      const zcodeOutcome = await discover(zcode);
      expect(zcodeOutcome.plugins[0]?.adapter).toMatchObject({
        adapterId: "zcode",
        manifestPath: ".zcode-plugin/plugin.json",
      });
    } finally {
      await rm(claude, { force: true, recursive: true });
      await rm(zcode, { force: true, recursive: true });
    }
  });

  it("detects a DSH bundle from package.json and marks its Cordis layer unsupported", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nibi-canonical-dsh-"));
    try {
      await writeJson(join(dir, "package.json"), {
        name: "dsh-hello-plugin",
        version: "0.1.0",
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      });

      const outcome = await discover(dir);
      expect(outcome.plugins[0]?.adapter).toEqual({
        adapterId: "dsh",
        compatibility: "partial",
        manifestPath: "package.json",
        skipped: ["dsh.bundle"],
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("ignores an ordinary npm package without a dsh.bundle declaration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nibi-canonical-npm-"));
    try {
      await writeJson(join(dir, "package.json"), {
        name: "ordinary-package",
        version: "1.0.0",
      });

      const outcome = await discover(dir);
      expect(outcome.plugins).toEqual([]);
      expect(outcome.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "plugin_manifest_not_found" }),
        ]),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("marks seeded official roots as builtin trust", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nibi-canonical-builtin-"));
    try {
      await writeJson(join(dir, "plugin.json"), {
        name: "builtin-one",
        version: "1.0.0",
        extensions: { "com.nibistudio.nibi": {} },
      });

      const outcome = await discover(dir, { official: true });
      expect(outcome.plugins[0]?.trust).toBe("builtin");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

async function publishMarker(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "README.md"), "fixture");
}
