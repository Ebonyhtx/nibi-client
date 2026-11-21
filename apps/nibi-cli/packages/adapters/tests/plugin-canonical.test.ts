import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createNodePluginAdapter,
  readPluginGrants,
  revokePluginConsent,
  revokePluginGrants,
  writePluginConsent,
  writePluginGrants,
} from "../src/plugins/index.js";

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

describe("plugin permission consent", () => {
  it("disables a local MCP plugin until the user consents to its required capabilities", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nibi-consent-missing-"));
    try {
      await writeJson(join(dir, "plugin.json"), {
        name: "consent-fixture",
        version: "1.0.0",
        extensions: { "com.nibistudio.nibi": { permissions: ["filesystem.read"] } },
      });
      await writeJson(join(dir, "mcp.json"), {
        mcpServers: { demo: { command: "node", args: ["server.mjs"] } },
      });

      const outcome = await discover(dir);
      expect(outcome.plugins[0]).toMatchObject({
        enabled: false,
        permissions: {
          requested: ["filesystem.read"],
          required: ["filesystem.read", "process", "network"],
        },
        trust: "local",
      });
      expect(outcome.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "plugin_consent_required",
            pluginId: "consent-fixture@inline",
          }),
        ]),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("enables the plugin after consent and disables it again when consent is revoked", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nibi-consent-grant-"));
    const storageRoot = join(dir, ".storage");
    try {
      await writeJson(join(dir, "plugin.json"), {
        name: "consent-fixture",
        version: "1.0.0",
        extensions: { "com.nibistudio.nibi": {} },
      });
      await writeJson(join(dir, "mcp.json"), {
        mcpServers: { demo: { command: "node", args: ["server.mjs"] } },
      });
      writePluginConsent({
        permissions: ["process", "network"],
        pluginId: "consent-fixture@inline",
        storageRoot,
        version: "1.0.0",
      });

      const granted = await discover(dir);
      expect(granted.plugins[0]?.enabled).toBe(true);

      revokePluginConsent(storageRoot, "consent-fixture@inline");
      const revoked = await discover(dir);
      expect(revoked.plugins[0]?.enabled).toBe(false);
      expect(revoked.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "plugin_consent_required" }),
        ]),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("requires re-consent after a version change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nibi-consent-version-"));
    const storageRoot = join(dir, ".storage");
    try {
      await writeJson(join(dir, "plugin.json"), {
        name: "consent-fixture",
        version: "2.0.0",
        extensions: { "com.nibistudio.nibi": {} },
      });
      await writeJson(join(dir, "mcp.json"), {
        mcpServers: { demo: { command: "node", args: ["server.mjs"] } },
      });
      writePluginConsent({
        permissions: ["process", "network"],
        pluginId: "consent-fixture@inline",
        storageRoot,
        version: "1.0.0",
      });

      const outcome = await discover(dir);
      expect(outcome.plugins[0]?.enabled).toBe(false);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("runs a pure skills plugin without consent and never requires full-access", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nibi-consent-skills-"));
    try {
      await writeJson(join(dir, "plugin.json"), {
        name: "skills-only",
        version: "1.0.0",
        extensions: {
          "com.nibistudio.nibi": { permissions: ["full-access"], skills: "skills" },
        },
      });
      await publishMarker(join(dir, "skills", "demo"));

      const outcome = await discover(dir);
      expect(outcome.plugins[0]).toMatchObject({
        enabled: true,
        permissions: { requested: ["full-access"], required: [] },
      });
      expect(outcome.diagnostics.some((item) => item.code === "plugin_consent_required")).toBe(
        false,
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("does not require consent for an official plugin with MCP", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nibi-consent-official-"));
    try {
      await writeJson(join(dir, "plugin.json"), {
        name: "official-mcp",
        version: "1.0.0",
        extensions: { "com.nibistudio.nibi": {} },
      });
      await writeJson(join(dir, "mcp.json"), {
        mcpServers: { demo: { command: "node", args: ["server.mjs"] } },
      });

      const outcome = await discover(dir, { official: true });
      expect(outcome.plugins[0]?.trust).toBe("builtin");
      expect(outcome.plugins[0]?.enabled).toBe(false); // bundled roots default off
      expect(outcome.diagnostics.some((item) => item.code === "plugin_consent_required")).toBe(
        false,
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("NIBI extension capabilities and runtime", () => {
  it("blocks a plugin that requests an unknown capability", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nibi-capability-unknown-"));
    try {
      await writeJson(join(dir, "plugin.json"), {
        name: "unknown-capability",
        version: "1.0.0",
        extensions: {
          "com.nibistudio.nibi": { capabilities: ["nibi.not.real"], skills: "skills" },
        },
      });
      await publishMarker(join(dir, "skills", "demo"));

      const outcome = await discover(dir);
      expect(outcome.plugins[0]?.enabled).toBe(false);
      expect(outcome.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "plugin_capability_unsupported" }),
        ]),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("requires a grant for sensitive capabilities and re-requires it after a version change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nibi-capability-grant-"));
    const storageRoot = join(dir, ".storage");
    try {
      await writeJson(join(dir, "plugin.json"), {
        name: "reader",
        version: "1.0.0",
        extensions: {
          "com.nibistudio.nibi": { capabilities: ["nibi.sessions.read"], skills: "skills" },
        },
      });
      await publishMarker(join(dir, "skills", "demo"));

      const missing = await discover(dir);
      expect(missing.plugins[0]).toMatchObject({
        capabilities: { granted: [], requested: [{ id: "nibi.sessions.read", scope: "workspace" }] },
        enabled: false,
      });
      expect(missing.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "plugin_capability_consent_required" }),
        ]),
      );

      writePluginGrants({
        grants: [{ id: "nibi.sessions.read", scope: "workspace" }],
        pluginId: "reader@inline",
        storageRoot,
        version: "1.0.0",
      });
      const granted = await discover(dir);
      expect(granted.plugins[0]?.enabled).toBe(true);
      expect(readPluginGrants(storageRoot).plugins["reader@inline"]?.epoch).toBe(1);

      revokePluginGrants(storageRoot, "reader@inline");
      const revoked = await discover(dir);
      expect(revoked.plugins[0]?.enabled).toBe(false);
      expect(readPluginGrants(storageRoot).plugins["reader@inline"]?.epoch).toBe(2);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("rejects host-scoped capabilities for local plugins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nibi-capability-host-"));
    try {
      await writeJson(join(dir, "plugin.json"), {
        name: "host-reader",
        version: "1.0.0",
        extensions: {
          "com.nibistudio.nibi": {
            capabilities: [{ id: "nibi.sessions.read", scope: "host" }],
            skills: "skills",
          },
        },
      });
      await publishMarker(join(dir, "skills", "demo"));

      const outcome = await discover(dir);
      expect(outcome.plugins[0]?.enabled).toBe(false);
      expect(outcome.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "plugin_capability_unsupported",
            message: expect.stringContaining("official-only"),
          }),
        ]),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("requires code consent for a local extension runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nibi-runtime-code-"));
    const storageRoot = join(dir, ".storage");
    try {
      await writeJson(join(dir, "plugin.json"), {
        name: "code-plugin",
        version: "1.0.0",
        extensions: {
          "com.nibistudio.nibi": {
            runtime: { apiVersion: "1", entry: "./extension.mjs" },
            skills: "skills",
          },
        },
      });
      await publishMarker(join(dir, "skills", "demo"));

      const missing = await discover(dir);
      expect(missing.plugins[0]).toMatchObject({
        enabled: false,
        permissions: { required: ["code"] },
        runtime: { apiVersion: "1", entry: "./extension.mjs" },
      });
      expect(missing.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "plugin_consent_required" }),
        ]),
      );

      writePluginConsent({
        permissions: ["code"],
        pluginId: "code-plugin@inline",
        storageRoot,
        version: "1.0.0",
      });
      const granted = await discover(dir);
      expect(granted.plugins[0]?.enabled).toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("diagnoses an escaping runtime entry but keeps declarative components", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nibi-runtime-invalid-"));
    try {
      await writeJson(join(dir, "plugin.json"), {
        name: "bad-runtime",
        version: "1.0.0",
        extensions: {
          "com.nibistudio.nibi": {
            runtime: { apiVersion: "1", entry: "../escape.mjs" },
            skills: "skills",
          },
        },
      });
      await publishMarker(join(dir, "skills", "demo"));

      const outcome = await discover(dir);
      expect(outcome.plugins[0]?.runtime).toBeUndefined();
      expect(outcome.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "plugin_runtime_invalid" }),
        ]),
      );
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("marks runtime unsupported for a foreign Claude layout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nibi-runtime-foreign-"));
    try {
      await writeJson(join(dir, ".claude-plugin", "plugin.json"), {
        name: "foreign-code",
        version: "1.0.0",
        runtime: { apiVersion: "1", entry: "./extension.mjs" },
        skills: "skills",
      });
      await publishMarker(join(dir, "skills", "demo"));

      const outcome = await discover(dir);
      expect(outcome.plugins[0]?.adapter).toMatchObject({
        adapterId: "claude",
        compatibility: "partial",
        skipped: ["runtime"],
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

async function publishMarker(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "README.md"), "fixture");
}
