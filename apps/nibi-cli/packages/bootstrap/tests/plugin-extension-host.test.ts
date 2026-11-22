import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PluginMetadata } from "@nibi/contracts";
import { activatePluginExtensions } from "../src/plugins.js";

function makePlugin(input: {
  dataPath: string;
  grantedCapabilities: string[];
  requestedCapabilities: string[];
  rootPath: string;
}): PluginMetadata {
  const requested = input.requestedCapabilities.map((id) => ({
    id: id as PluginMetadata["capabilities"]["requested"][number]["id"],
    scope: "workspace" as const,
  }));
  return {
    capabilities: {
      granted: requested.filter((grant) => input.grantedCapabilities.includes(grant.id)),
      requested,
    },
    commandRootCount: 0,
    components: [],
    dataPath: input.dataPath,
    declaredMcpServerNames: [],
    enabled: true,
    id: "extension-fixture@inline",
    manifestPath: join(input.rootPath, "plugin.json"),
    marketplace: "inline",
    mcpServerNames: [],
    name: "extension-fixture",
    origin: "local",
    hookDetails: [],
    permissions: { requested: ["code"], required: ["code"] },
    rootPath: input.rootPath,
    runtime: { apiVersion: "1", entry: "./extension.mjs" },
    skillCount: 0,
    skillRootCount: 0,
    source: "inline",
    trust: "local",
    version: "1.0.0",
  };
}

const EXTENSION_SOURCE = `
export async function activate(context) {
  const out = {};
  try {
    out.file = await context.nibi.workspace.readFile("note.txt");
  } catch (error) {
    out.fileError = String(error);
  }
  try {
    await context.nibi.workspace.readFile(".env");
    out.secretRead = true;
  } catch (error) {
    out.secretError = String(error);
  }
  out.sessions = await context.nibi.sessions.read({ limit: 5 });
  await context.nibi.settings.set({ out });
  out.view = await context.nibi.ui.openView("panel");
  await context.nibi.notifications.show({ title: "ready" });
}
export async function deactivate() {}
`;

describe("plugin extension host", () => {
  it("activates a local plugin in its own process and enforces capability boundaries", async () => {
    const root = await mkdtemp(join(tmpdir(), "nibi-extension-host-"));
    const pluginRoot = join(root, "plugin");
    const storageRoot = join(root, "plugins");
    const dataPath = join(storageRoot, "data", "extension-fixture@inline");
    const notifications: string[] = [];
    const opened: Array<{ pluginId: string; surfaceId: string }> = [];
    try {
      await mkdir(pluginRoot, { recursive: true });
      await mkdir(dataPath, { recursive: true });
      await writeFile(join(root, "note.txt"), "hello workspace");
      await writeFile(join(root, ".env"), "SECRET=1");
      await writeFile(
        join(pluginRoot, "extension.mjs"),
        EXTENSION_SOURCE,
      );
      const plugin = makePlugin({
        dataPath,
        grantedCapabilities: [
          "nibi.sessions.read",
          "nibi.ui.view",
          "nibi.workspace.files.read",
          "nibi.settings.own",
          "nibi.notifications.show",
        ],
        requestedCapabilities: [
          "nibi.sessions.read",
          "nibi.ui.view",
          "nibi.workspace.files.read",
          "nibi.settings.own",
          "nibi.notifications.show",
        ],
        rootPath: pluginRoot,
      });

      const host = await activatePluginExtensions({
        plugins: [plugin],
        storageRoot,
        workspacePath: root,
        handlers: {
          readSessions: () => [{ id: "session-1", title: "Hello" }],
          openView: (input) => {
            opened.push(input);
          },
          showNotification: (input) => {
            notifications.push(`${input.pluginId}:${input.title}`);
          },
        },
      });
      try {
        const settings = JSON.parse(
          await readFile(join(dataPath, "settings.json"), "utf8"),
        ) as { out: Record<string, unknown> };
        expect(settings.out.file).toMatchObject({
          content: "hello workspace",
          truncated: false,
        });
        expect(settings.out.secretRead).toBeUndefined();
        expect(String(settings.out.secretError)).toContain("Sensitive file");
        expect(settings.out.sessions).toEqual([{ id: "session-1", title: "Hello" }]);
        expect(notifications).toEqual(["extension-fixture@inline:ready"]);
        expect(opened).toEqual([
          { pluginId: "extension-fixture@inline", surfaceId: "panel" },
        ]);

        const audit = await readFile(join(storageRoot, "plugin-audit.ndjson"), "utf8");
        expect(audit).toContain('"capability_invoked"');
        expect(audit).toContain('"capability_denied"');
        expect(audit).toContain("nibi.workspace.files.read");
      } finally {
        await host.dispose();
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);
});
