import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuiltinPaidPluginGate } from "../src/plugins/paid-plugin-discovery-gate.js";
import { discoverNodePluginsSync } from "../src/plugins/index.js";
import { createSharedZCodeCredentialStore } from "../src/auth/shared-credentials.js";
import { NIBI_LICENSE_ISSUER } from "@nibi/shared";
import type {
  PaidPluginGateInput,
  PaidPluginGateResult,
} from "@nibi/contracts";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `nibi-paid-gate-${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })),
  );
});

interface TestLicenseKey {
  publicKeys: Record<string, string>;
  signToken: (claims: Record<string, unknown>) => string;
}

function makeTestLicenseKey(): TestLicenseKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const kid = "test-key-1";
  const b64url = (value: Buffer) => value.toString("base64url");
  return {
    publicKeys: { [kid]: publicPem },
    signToken: (claims) => {
      const header = b64url(Buffer.from(JSON.stringify({ alg: "Ed25519", kid }), "utf8"));
      const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
      const signature = edSign(
        null,
        Buffer.from(`${header}.${payload}`, "utf8"),
        privateKey,
      );
      return `${header}.${payload}.${b64url(signature)}`;
    },
  };
}

function licenseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: NIBI_LICENSE_ISSUER,
    sub: "user-1",
    plugins: ["*"],
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
}

async function writeTokenToCredentialStore(input: {
  credentialRoot: string;
  token: string;
}): Promise<void> {
  const store = createSharedZCodeCredentialStore({ env: { NIBI_DATA_BASE_DIR: input.credentialRoot } });
  await store.saveMany({ "nibi:license:token": input.token });
}

/** 付费插件夹具：带 mcp/skill/command/hook 四类能力根 + 安装记录与市场清单。 */
async function writePaidPluginFixture(input: {
  pluginName: string;
  marketplace: string;
  manifestPaid?: boolean;
  installedPaid?: boolean;
}): Promise<{ storageRoot: string; pluginRoot: string }> {
  const storageRoot = await makeTempDir("storage");
  const pluginRoot = join(await makeTempDir("plugin"), input.pluginName);
  await mkdir(join(pluginRoot, ".nibi-plugin"), { recursive: true });
  await writeFile(
    join(pluginRoot, ".nibi-plugin", "plugin.json"),
    JSON.stringify({
      name: input.pluginName,
      version: "1.0.0",
      hooks: "hooks/hooks.json",
      skills: "skills",
      commands: "commands",
    }),
  );
  await writeFile(
    join(pluginRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: { main: { command: "node", args: ["server.js"], type: "stdio" } },
    }),
  );
  await mkdir(join(pluginRoot, "skills", "demo"), { recursive: true });
  await writeFile(
    join(pluginRoot, "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: demo skill\n---\n\nbody\n",
  );
  await mkdir(join(pluginRoot, "commands"), { recursive: true });
  await writeFile(join(pluginRoot, "commands", "demo.md"), "---\ndescription: demo\n---\nbody\n");
  await mkdir(join(pluginRoot, "hooks"), { recursive: true });
  await writeFile(
    join(pluginRoot, "hooks", "hooks.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hi" }] }],
      },
    }),
  );

  await writeFile(
    join(storageRoot, "installed_plugins.json"),
    JSON.stringify({
      plugins: [
        {
          id: `${input.pluginName}@${input.marketplace}`,
          name: input.pluginName,
          marketplace: input.marketplace,
          version: "1.0.0",
          installPath: pluginRoot,
          installedAt: new Date().toISOString(),
          scope: "user",
          ...(input.installedPaid === false ? {} : { paid: true }),
        },
      ],
    }),
  );

  if (input.manifestPaid !== undefined) {
    const manifestDir = join(storageRoot, "marketplaces", input.marketplace);
    await mkdir(manifestDir, { recursive: true });
    await writeFile(
      join(manifestDir, "marketplace.json"),
      JSON.stringify({
        name: input.marketplace,
        plugins: [
          { name: input.pluginName, source: `./${input.pluginName}`, paid: input.manifestPaid },
        ],
      }),
    );
  }
  return { storageRoot, pluginRoot };
}

function discover(input: {
  storageRoot: string;
  pluginName: string;
  marketplace: string;
  env?: Record<string, string | undefined>;
  gate?: (plugin: PaidPluginGateInput) => PaidPluginGateResult;
}) {
  return discoverNodePluginsSync({
    config: {
      dirs: [],
      enabled: true,
      enabledPlugins: { [`${input.pluginName}@${input.marketplace}`]: true },
      options: {},
    },
    env: input.env ?? {},
    ...(input.gate ? { paidPluginGate: input.gate } : {}),
    storageRoot: input.storageRoot,
    workingDirectory: input.storageRoot,
  });
}

describe("paid plugin discovery gate", () => {
  it("denies an installed paid plugin without a license and prunes every capability root", async () => {
    const credentialRoot = await makeTempDir("creds");
    const { storageRoot } = await writePaidPluginFixture({
      pluginName: "paid-tool",
      marketplace: "test-mp",
    });
    const outcome = discover({
      storageRoot,
      pluginName: "paid-tool",
      marketplace: "test-mp",
      env: { NIBI_DATA_BASE_DIR: credentialRoot },
    });

    const plugin = outcome.plugins.find((item) => item.id === "paid-tool@test-mp");
    expect(plugin?.enabled).toBe(false);
    expect(Object.keys(outcome.mcpServers)).toEqual([]);
    expect(outcome.skillRoots).toEqual([]);
    expect(outcome.commandRoots).toEqual([]);
    expect(outcome.hooks.SessionStart ?? []).toEqual([]);
    expect(
      outcome.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "plugin_membership_required" &&
          diagnostic.pluginId === "paid-tool@test-mp" &&
          diagnostic.severity === "error",
      ),
    ).toBe(true);
  });

  it("denies a plugin that only the marketplace manifest marks paid", async () => {
    const credentialRoot = await makeTempDir("creds");
    const { storageRoot } = await writePaidPluginFixture({
      pluginName: "paid-tool",
      marketplace: "test-mp",
      installedPaid: false,
      manifestPaid: true,
    });
    const outcome = discover({
      storageRoot,
      pluginName: "paid-tool",
      marketplace: "test-mp",
      env: { NIBI_DATA_BASE_DIR: credentialRoot },
    });
    expect(outcome.plugins.find((item) => item.id === "paid-tool@test-mp")?.enabled).toBe(false);
    expect(Object.keys(outcome.mcpServers)).toEqual([]);
    expect(outcome.skillRoots).toEqual([]);
    expect(outcome.commandRoots).toEqual([]);
  });

  it("keeps every capability root for a plugin covered by a valid license token", async () => {
    const key = makeTestLicenseKey();
    const credentialRoot = await makeTempDir("creds");
    await writeTokenToCredentialStore({
      credentialRoot,
      token: key.signToken(licenseClaims()),
    });
    const { storageRoot } = await writePaidPluginFixture({
      pluginName: "paid-tool",
      marketplace: "test-mp",
    });
    const gate = createBuiltinPaidPluginGate({
      env: { NIBI_DATA_BASE_DIR: credentialRoot },
      publicKeys: key.publicKeys,
      storageRoot,
    });
    const outcome = discover({
      storageRoot,
      pluginName: "paid-tool",
      marketplace: "test-mp",
      gate,
    });
    const plugin = outcome.plugins.find((item) => item.id === "paid-tool@test-mp");
    expect(plugin?.enabled).toBe(true);
    expect(Object.keys(outcome.mcpServers)).toEqual(["plugin:paid-tool:main"]);
    expect(outcome.skillRoots).toHaveLength(1);
    expect(outcome.commandRoots).toHaveLength(1);
    expect(outcome.hooks.SessionStart).toHaveLength(1);
    expect(outcome.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });

  it("denies an expired license token", async () => {
    const key = makeTestLicenseKey();
    const credentialRoot = await makeTempDir("creds");
    await writeTokenToCredentialStore({
      credentialRoot,
      token: key.signToken(licenseClaims({ exp: Math.floor(Date.now() / 1000) - 60 })),
    });
    const { storageRoot } = await writePaidPluginFixture({
      pluginName: "paid-tool",
      marketplace: "test-mp",
    });
    const gate = createBuiltinPaidPluginGate({
      env: { NIBI_DATA_BASE_DIR: credentialRoot },
      publicKeys: key.publicKeys,
      storageRoot,
    });
    const result = gate({ id: "paid-tool@test-mp", marketplace: "test-mp", name: "paid-tool" });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.message).toContain("到期");
    }
  });

  it("denies a token that does not cover the requested plugin", async () => {
    const key = makeTestLicenseKey();
    const credentialRoot = await makeTempDir("creds");
    await writeTokenToCredentialStore({
      credentialRoot,
      token: key.signToken(licenseClaims({ plugins: ["other-plugin"] })),
    });
    const { storageRoot } = await writePaidPluginFixture({
      pluginName: "paid-tool",
      marketplace: "test-mp",
    });
    const gate = createBuiltinPaidPluginGate({
      env: { NIBI_DATA_BASE_DIR: credentialRoot },
      publicKeys: key.publicKeys,
      storageRoot,
    });
    const result = gate({ id: "paid-tool@test-mp", marketplace: "test-mp", name: "paid-tool" });
    expect(result.allowed).toBe(false);
  });

  it("rejects a token signed by an unknown key (fail-closed on kid)", async () => {
    const key = makeTestLicenseKey();
    const credentialRoot = await makeTempDir("creds");
    await writeTokenToCredentialStore({
      credentialRoot,
      token: key.signToken(licenseClaims()),
    });
    const { storageRoot } = await writePaidPluginFixture({
      pluginName: "paid-tool",
      marketplace: "test-mp",
    });
    // 验签表不含测试 kid：用另一个空表强制未知 key 路径。
    const gate = createBuiltinPaidPluginGate({
      env: { NIBI_DATA_BASE_DIR: credentialRoot },
      publicKeys: {},
      storageRoot,
    });
    expect(
      gate({ id: "paid-tool@test-mp", marketplace: "test-mp", name: "paid-tool" }).allowed,
    ).toBe(false);
  });

  it("does not gate free plugins at all", async () => {
    const { storageRoot } = await writePaidPluginFixture({
      pluginName: "free-tool",
      marketplace: "test-mp",
      installedPaid: false,
    });
    const outcome = discover({
      storageRoot,
      pluginName: "free-tool",
      marketplace: "test-mp",
    });
    const plugin = outcome.plugins.find((item) => item.id === "free-tool@test-mp");
    expect(plugin?.enabled).toBe(true);
    expect(Object.keys(outcome.mcpServers)).toEqual(["plugin:free-tool:main"]);
    expect(outcome.skillRoots).toHaveLength(1);
    expect(outcome.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  });
});
