import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig, NativeMcpServerRecord } from "@nibi/shared";
import { loadCliMcpFromUserDirectory } from "../src/main/mcpUserDirectory/index.js";
import {
  computeWorkspaceMcpDeclarationDigest,
  createWorkspaceMcpTrustRegistry,
  decideWorkspaceMcpTrust,
  filterTrustedProjectMcpRecords,
  inspectWorkspaceMcpTrust,
  isWorkspaceRegisteredForMcpInspection,
  readWorkspaceMcpTrustStore,
  resolveWorkspaceMcpTrustStorePath,
  writeWorkspaceMcpTrustDecision,
} from "../src/main/mcpWorkspaceTrust/index.js";
import {
  decideWorkspaceMcpTrustForWindow,
  parseWorkspaceMcpTrustDecisionRequest,
} from "../src/main/mcpWorkspaceTrustIpc.js";

const roots: string[] = [];
const originalEnv = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  NIBI_STORAGE_DIR: process.env.NIBI_STORAGE_DIR,
  NIBI_HOME: process.env.NIBI_HOME,
};

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function projectRecord(
  workspacePath: string,
  name: string,
  config: McpServerConfig,
): NativeMcpServerRecord {
  return {
    source: "zcodeagentmcp",
    scope: "workspace",
    name,
    config,
    enabled: true,
    projectPath: workspacePath,
    file: { format: "json", filePath: join(workspacePath, ".nibi", "config.json") },
    location: {
      source: "nibi",
      scope: "project",
      directoryPath: join(workspacePath, ".nibi"),
      projectPath: workspacePath,
    },
  };
}

function userRecord(name: string, config: McpServerConfig): NativeMcpServerRecord {
  return {
    source: "zcodeagentmcp",
    scope: "user",
    name,
    config,
    enabled: true,
  };
}

const probeConfig: McpServerConfig = { type: "stdio", command: "node" };

beforeEach(() => {
  const home = join(tmpdir(), `nibi-mcp-trust-home-${process.pid}-${Date.now()}-${Math.random()}`);
  roots.push(home);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.NIBI_STORAGE_DIR;
  delete process.env.NIBI_HOME;
});

afterEach(async () => {
  process.env.HOME = originalEnv.HOME;
  process.env.USERPROFILE = originalEnv.USERPROFILE;
  if (originalEnv.NIBI_STORAGE_DIR === undefined) delete process.env.NIBI_STORAGE_DIR;
  else process.env.NIBI_STORAGE_DIR = originalEnv.NIBI_STORAGE_DIR;
  if (originalEnv.NIBI_HOME === undefined) delete process.env.NIBI_HOME;
  else process.env.NIBI_HOME = originalEnv.NIBI_HOME;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace MCP declaration digest", () => {
  it("matches the Rust kernel fixed vector", () => {
    // 与 crates/ext/src/mcp/trust_tests.rs 的 DIGEST_VECTOR_EXPECTED 同一个值。
    expect(
      computeWorkspaceMcpDeclarationDigest({
        workspaceIdentity: "/workspace/alpha",
        serverName: "probe",
        config: { type: "stdio", command: "node" },
      }),
    ).toBe("6781e00d56fceeb639263a7ee238dcfe1c8f6b922616d91337acf85b78304d14");
  });

  it("normalizes legacy aliases and invalidates on execution fields", () => {
    const legacy = computeWorkspaceMcpDeclarationDigest({
      workspaceIdentity: "/ws",
      serverName: "probe",
      config: { command: "node", environment: {} },
    });
    const canonical = computeWorkspaceMcpDeclarationDigest({
      workspaceIdentity: "/ws",
      serverName: "probe",
      config: { type: "stdio", command: "node", env: {} },
    });
    expect(legacy).toBe(canonical);

    const withEnv = computeWorkspaceMcpDeclarationDigest({
      workspaceIdentity: "/ws",
      serverName: "probe",
      config: { command: "node", env: { TOKEN: "one" } },
    });
    expect(withEnv).not.toBe(canonical);
    expect(
      computeWorkspaceMcpDeclarationDigest({
        workspaceIdentity: "/ws",
        serverName: "probe",
        config: { command: "node", env: { TOKEN: "two" } },
      }),
    ).not.toBe(withEnv);
  });

  it("does not review declarations that cannot be normalized", async () => {
    const workspace = await makeRoot("nibi-mcp-trust-invalid-");
    const records = [projectRecord(workspace, "broken", { type: "stdio" })];
    const inspected = await inspectWorkspaceMcpTrust({
      records,
      workspacePath: workspace,
      storePath: join(workspace, "trust.json"),
    });
    expect(inspected.reviews).toEqual({});
    expect(inspected.unreviewable).toEqual(["broken"]);
    expect(filterTrustedProjectMcpRecords({ records, reviews: {} })).toEqual([]);
  });

  it("redacts credentials from the review display", async () => {
    const workspace = await makeRoot("nibi-mcp-trust-display-");
    const inspected = await inspectWorkspaceMcpTrust({
      records: [
        projectRecord(workspace, "stdio_probe", {
          type: "stdio",
          command: "node",
          args: ["server.mjs", "--token", "secret-argument"],
          env: { API_KEY: "secret-env" },
        }),
        projectRecord(workspace, "http_probe", {
          type: "http",
          url: "https://user:secret-password@mcp.example.test/mcp?token=secret-query",
          headers: { Authorization: "Bearer secret-header" },
        }),
      ],
      workspacePath: workspace,
      storePath: join(workspace, "trust.json"),
    });
    const display = Object.values(inspected.reviews)
      .map((review) => review.display)
      .join("\n");
    expect(display).not.toContain("secret-argument");
    expect(display).not.toContain("secret-env");
    expect(display).not.toContain("secret-password");
    expect(display).not.toContain("secret-query");
    expect(display).not.toContain("secret-header");
    expect(display).toContain("API_KEY");
  });
});

describe("trust admissions", () => {
  it("does not load untrusted project MCP while keeping user MCP", async () => {
    const workspace = await makeRoot("nibi-mcp-trust-untrusted-");
    const records = [
      projectRecord(workspace, "probe", probeConfig),
      userRecord("user_probe", probeConfig),
    ];
    const inspected = await inspectWorkspaceMcpTrust({
      records,
      workspacePath: workspace,
      storePath: join(workspace, "trust.json"),
    });
    expect(inspected.reviews.probe?.trusted).toBe(false);
    expect(inspected.reviews.probe?.declarationDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      filterTrustedProjectMcpRecords({ records, reviews: inspected.reviews }).map(
        (record) => record.name,
      ),
    ).toEqual(["user_probe"]);
  });

  it("deciding on a changed declaration is rejected without writing", async () => {
    const workspace = await makeRoot("nibi-mcp-trust-changed-");
    const storePath = join(workspace, "security", "workspace-mcp-trust-v1.json");
    const records = [projectRecord(workspace, "probe", probeConfig)];
    const old = await inspectWorkspaceMcpTrust({ records, workspacePath: workspace, storePath });
    const oldDigest = old.reviews.probe!.declarationDigest;

    const changed = [
      projectRecord(workspace, "probe", { ...probeConfig, env: { VERSION: "2" } }),
    ];
    const next = await inspectWorkspaceMcpTrust({ records: changed, workspacePath: workspace, storePath });
    expect(next.reviews.probe!.declarationDigest).not.toBe(oldDigest);
    expect(next.reviews.probe!.trusted).toBe(false);

    const decision = await decideWorkspaceMcpTrust({
      records: changed,
      workspacePath: workspace,
      serverName: "probe",
      declarationDigest: oldDigest,
      trusted: true,
      storePath,
    });
    expect(decision).toEqual({
      accepted: false,
      reasonCode: "workspace_mcp_declaration_changed",
    });
    expect((await readWorkspaceMcpTrustStore(storePath)).status).toBe("missing");
  });

  it("marks declarationChanged when the user store still holds an older digest", async () => {
    const workspace = await makeRoot("nibi-mcp-trust-changed-flag-");
    const storePath = join(workspace, "security", "workspace-mcp-trust-v1.json");
    const records = [projectRecord(workspace, "probe", probeConfig)];
    const initial = await inspectWorkspaceMcpTrust({ records, workspacePath: workspace, storePath });
    expect(initial.reviews.probe).toMatchObject({
      trusted: false,
      declarationChanged: false,
    });

    await decideWorkspaceMcpTrust({
      records,
      workspacePath: workspace,
      serverName: "probe",
      declarationDigest: initial.reviews.probe!.declarationDigest,
      trusted: true,
      storePath,
    });
    const trusted = await inspectWorkspaceMcpTrust({ records, workspacePath: workspace, storePath });
    expect(trusted.reviews.probe).toMatchObject({
      trusted: true,
      declarationChanged: false,
    });

    const changedRecords = [
      projectRecord(workspace, "probe", { ...probeConfig, env: { VERSION: "2" } }),
    ];
    const changed = await inspectWorkspaceMcpTrust({
      records: changedRecords,
      workspacePath: workspace,
      storePath,
    });
    expect(changed.reviews.probe).toMatchObject({
      trusted: false,
      declarationChanged: true,
    });
  });

  it("revokes trust through decide(trusted:false)", async () => {
    const workspace = await makeRoot("nibi-mcp-trust-revoke-");
    const storePath = join(workspace, "security", "workspace-mcp-trust-v1.json");
    const records = [projectRecord(workspace, "probe", probeConfig)];
    const inspected = await inspectWorkspaceMcpTrust({ records, workspacePath: workspace, storePath });
    const declarationDigest = inspected.reviews.probe!.declarationDigest;

    expect(
      await decideWorkspaceMcpTrust({
        records,
        workspacePath: workspace,
        serverName: "probe",
        declarationDigest,
        trusted: true,
        storePath,
      }),
    ).toEqual({ accepted: true });
    expect(
      (await inspectWorkspaceMcpTrust({ records, workspacePath: workspace, storePath })).reviews
        .probe?.trusted,
    ).toBe(true);

    expect(
      await decideWorkspaceMcpTrust({
        records,
        workspacePath: workspace,
        serverName: "probe",
        declarationDigest,
        trusted: false,
        storePath,
      }),
    ).toEqual({ accepted: true });
    const afterRevoke = await inspectWorkspaceMcpTrust({
      records,
      workspacePath: workspace,
      storePath,
    });
    expect(afterRevoke.reviews.probe).toMatchObject({
      trusted: false,
      declarationChanged: false,
    });
    expect(
      filterTrustedProjectMcpRecords({ records, reviews: afterRevoke.reviews }),
    ).toEqual([]);
  });

  it("does not grant or inspect offline and unregistered workspaces", async () => {
    const workspace = await makeRoot("nibi-mcp-trust-offline-");
    const records = [projectRecord(workspace, "probe", probeConfig)];
    const storePath = join(workspace, "security", "workspace-mcp-trust-v1.json");
    const digest = computeWorkspaceMcpDeclarationDigest({
      workspaceIdentity: workspace,
      serverName: "probe",
      config: probeConfig,
    })!;

    expect(
      await inspectWorkspaceMcpTrust({ records, workspacePath: workspace, storePath, online: false }),
    ).toEqual({ reviews: {}, unreviewable: [] });

    const registry = createWorkspaceMcpTrustRegistry();
    expect(
      await inspectWorkspaceMcpTrust({
        records,
        workspacePath: workspace,
        storePath,
        registeredWorkspaces: registry,
      }),
    ).toEqual({ reviews: {}, unreviewable: [] });

    expect(
      await decideWorkspaceMcpTrust({
        records,
        workspacePath: workspace,
        serverName: "probe",
        declarationDigest: digest,
        trusted: true,
        storePath,
        registeredWorkspaces: registry,
      }),
    ).toEqual({ accepted: false, reasonCode: "workspace_mcp_workspace_not_registered" });

    registry.register({ workspacePath: workspace, online: false });
    expect(
      await inspectWorkspaceMcpTrust({
        records,
        workspacePath: workspace,
        storePath,
        registeredWorkspaces: registry,
      }),
    ).toEqual({ reviews: {}, unreviewable: [] });
    expect(
      await decideWorkspaceMcpTrust({
        records,
        workspacePath: workspace,
        serverName: "probe",
        declarationDigest: digest,
        trusted: true,
        storePath,
        registeredWorkspaces: registry,
      }),
    ).toEqual({ accepted: false, reasonCode: "workspace_mcp_workspace_offline" });
    expect((await readWorkspaceMcpTrustStore(storePath)).status).toBe("missing");
  });
});

describe("trust store owner", () => {
  it("writes atomically, preserves other records and never touches config.json", async () => {
    const storageRoot = await makeRoot("nibi-mcp-trust-store-");
    const workspace = join(storageRoot, "workspace");
    await mkdir(join(workspace, ".nibi"), { recursive: true });
    const configPath = join(workspace, ".nibi", "config.json");
    const configBytes = `${JSON.stringify({ mcp: { servers: { probe: probeConfig } } }, null, 2)}\n`;
    await writeFile(configPath, configBytes);

    const storePath = await resolveWorkspaceMcpTrustStorePath({ storageRoot });
    await mkdir(join(storageRoot, "security"), { recursive: true });
    await writeFile(
      storePath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          records: [
            {
              workspaceIdentity: "/elsewhere",
              serverName: "probe",
              declarationDigest: "c".repeat(64),
              grantedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const records = [projectRecord(workspace, "probe", probeConfig)];
    const digest = computeWorkspaceMcpDeclarationDigest({
      workspaceIdentity: workspace,
      serverName: "probe",
      config: probeConfig,
    })!;
    const decision = await decideWorkspaceMcpTrust({
      records,
      workspacePath: workspace,
      serverName: "probe",
      declarationDigest: digest,
      trusted: true,
      storageRoot,
    });
    expect(decision).toEqual({ accepted: true });

    const store = JSON.parse(await readFile(storePath, "utf8")) as {
      schemaVersion: number;
      records: Array<{ workspaceIdentity: string; serverName: string; declarationDigest: string }>;
    };
    expect(store.schemaVersion).toBe(1);
    expect(store.records).toHaveLength(2);
    expect(store.records.map((record) => record.workspaceIdentity).sort()).toEqual([
      "/elsewhere",
      workspace,
    ]);
    expect(await readFile(configPath, "utf8")).toBe(configBytes);
    if (process.platform !== "win32") {
      expect((await stat(storePath)).mode & 0o777).toBe(0o600);
    }

    const trusted = await inspectWorkspaceMcpTrust({ records, workspacePath: workspace, storageRoot });
    expect(trusted.reviews.probe?.trusted).toBe(true);
    expect(
      filterTrustedProjectMcpRecords({ records, reviews: trusted.reviews }).map((record) => record.name),
    ).toEqual(["probe"]);

    // 撤销只删精确摘要，其他工作区记录保留。
    await writeWorkspaceMcpTrustDecision({
      storePath,
      workspaceIdentity: workspace,
      serverName: "probe",
      declarationDigest: digest,
      trusted: false,
    });
    const afterRevoke = JSON.parse(await readFile(storePath, "utf8")) as {
      records: Array<{ workspaceIdentity: string }>;
    };
    expect(afterRevoke.records.map((record) => record.workspaceIdentity)).toEqual(["/elsewhere"]);
  });

  it("rejects corrupt stores without overwriting them", async () => {
    const workspace = await makeRoot("nibi-mcp-trust-corrupt-");
    const storePath = join(workspace, "security", "workspace-mcp-trust-v1.json");
    await mkdir(join(workspace, "security"), { recursive: true });
    for (const corrupt of ["{broken", '{"schemaVersion":99,"records":[]}']) {
      await writeFile(storePath, corrupt);
      const records = [projectRecord(workspace, "probe", probeConfig)];
      const inspected = await inspectWorkspaceMcpTrust({ records, workspacePath: workspace, storePath });
      expect(inspected.reviews.probe?.trusted).toBe(false);
      const decision = await decideWorkspaceMcpTrust({
        records,
        workspacePath: workspace,
        serverName: "probe",
        declarationDigest: inspected.reviews.probe!.declarationDigest,
        trusted: true,
        storePath,
      });
      expect(decision).toEqual({
        accepted: false,
        reasonCode: "workspace_mcp_trust_unavailable",
      });
      expect(await readFile(storePath, "utf8")).toBe(corrupt);
    }
  });
});

describe("desktop workspace MCP trust decision bridge", () => {
  it("parses only well-formed decision payloads", () => {
    expect(parseWorkspaceMcpTrustDecisionRequest(null)).toBeNull();
    expect(
      parseWorkspaceMcpTrustDecisionRequest({
        workspacePath: "/ws",
        serverName: "probe",
        declarationDigest: "a".repeat(64),
        trusted: "yes",
      }),
    ).toBeNull();
    expect(
      parseWorkspaceMcpTrustDecisionRequest({
        workspacePath: "/ws",
        workspaceIdentity: "ssh:host:/ws",
        serverName: "probe",
        declarationDigest: "a".repeat(64),
        trusted: true,
      }),
    ).toEqual({
      workspacePath: "/ws",
      workspaceIdentity: "ssh:host:/ws",
      serverName: "probe",
      declarationDigest: "a".repeat(64),
      trusted: true,
    });
  });

  it("rejects windows that have not registered the workspace before reading files", async () => {
    const loadRecords = vi.fn();
    const decision = await decideWorkspaceMcpTrustForWindow({
      windowWorkspaceMap: new Map(),
      windowId: 7,
      payload: {
        workspacePath: "/workspace/unregistered",
        serverName: "probe",
        declarationDigest: "a".repeat(64),
        trusted: true,
      },
      loadRecords,
    });
    expect(decision).toEqual({
      accepted: false,
      reasonCode: "workspace_mcp_workspace_not_registered",
    });
    expect(loadRecords).not.toHaveBeenCalled();
  });

  it("persists the exact reviewed digest for a registered window", async () => {
    const workspace = await makeRoot("nibi-mcp-trust-ipc-");
    const records = [projectRecord(workspace, "probe", probeConfig)];
    const declarationDigest = computeWorkspaceMcpDeclarationDigest({
      workspaceIdentity: workspace,
      serverName: "probe",
      config: probeConfig,
    })!;
    const loadRecords = vi.fn(async () => ({ servers: records, trust: {} }));
    const decision = await decideWorkspaceMcpTrustForWindow({
      windowWorkspaceMap: new Map([[7, new Set([workspace])]]),
      windowId: 7,
      payload: {
        workspacePath: workspace,
        serverName: "probe",
        declarationDigest,
        trusted: true,
      },
      loadRecords,
    });
    expect(decision).toEqual({ accepted: true });

    const inspected = await inspectWorkspaceMcpTrust({
      records,
      workspacePath: workspace,
      storePath: await resolveWorkspaceMcpTrustStorePath(),
    });
    expect(inspected.reviews.probe?.trusted).toBe(true);
  });

  it("fails closed when the project declarations cannot be read", async () => {
    const workspace = await makeRoot("nibi-mcp-trust-ipc-fail-");
    const decision = await decideWorkspaceMcpTrustForWindow({
      windowWorkspaceMap: new Map([[3, new Set([workspace])]]),
      windowId: 3,
      payload: {
        workspacePath: workspace,
        serverName: "probe",
        declarationDigest: "a".repeat(64),
        trusted: true,
      },
      loadRecords: vi.fn(async () => {
        throw new SyntaxError("broken config");
      }),
    });
    expect(decision).toEqual({
      accepted: false,
      reasonCode: "workspace_mcp_trust_unavailable",
    });
  });

  it("does not write when the Host reports an offline workspace", async () => {
    const workspace = await makeRoot("nibi-mcp-trust-ipc-offline-");
    const decision = await decideWorkspaceMcpTrustForWindow({
      windowWorkspaceMap: new Map([[4, new Set([workspace])]]),
      windowId: 4,
      payload: {
        workspacePath: workspace,
        serverName: "probe",
        declarationDigest: "a".repeat(64),
        trusted: true,
      },
      loadRecords: vi.fn(async () => ({
        servers: [],
        trustReasonCode: "workspace_mcp_workspace_offline" as const,
      })),
    });
    expect(decision).toEqual({
      accepted: false,
      reasonCode: "workspace_mcp_workspace_offline",
    });
    expect(
      (await readWorkspaceMcpTrustStore(await resolveWorkspaceMcpTrustStorePath())).status,
    ).toBe("missing");
  });
});

describe("A6 registered workspaces", () => {
  it("only accepts workspaces registered for the same window", () => {
    const windows = new Map<number, Set<string>>([[1, new Set(["/workspace/a/"])]]);
    expect(isWorkspaceRegisteredForMcpInspection(windows, 1, "/workspace/a")).toBe(true);
    expect(isWorkspaceRegisteredForMcpInspection(windows, 1, "/workspace/b")).toBe(false);
    expect(isWorkspaceRegisteredForMcpInspection(windows, 2, "/workspace/a")).toBe(false);
    expect(isWorkspaceRegisteredForMcpInspection(windows, 1, undefined)).toBe(false);
    expect(isWorkspaceRegisteredForMcpInspection(new Map(), 1, "/workspace/a")).toBe(false);
  });

  it("does not read project MCP for an unregistered workspace", async () => {
    const storageRoot = await makeRoot("nibi-mcp-trust-registered-");
    const workspace = join(storageRoot, "workspace");
    await mkdir(join(workspace, ".nibi"), { recursive: true });
    await writeFile(
      join(workspace, ".nibi", "config.json"),
      JSON.stringify({ mcp: { servers: { probe: probeConfig } } }),
    );
    await mkdir(join(storageRoot, ".nibi", "cli"), { recursive: true });
    await writeFile(
      join(storageRoot, ".nibi", "cli", "config.json"),
      JSON.stringify({ mcp: { servers: { user_probe: probeConfig } } }),
    );
    process.env.NIBI_STORAGE_DIR = storageRoot;

    const unregistered = await loadCliMcpFromUserDirectory(
      { workspacePath: workspace },
      { workspaceRegistered: false },
    );
    expect(unregistered.servers.map((server) => server.name)).toEqual(["user_probe"]);
    expect(unregistered.trust).toBeUndefined();
    expect(unregistered.trustReasonCode).toBe("workspace_mcp_workspace_not_registered");

    const registered = await loadCliMcpFromUserDirectory(
      { workspacePath: workspace },
      { workspaceRegistered: true, storageRoot },
    );
    expect(registered.servers.map((server) => server.name).sort()).toEqual([
      "probe",
      "user_probe",
    ]);
    expect(registered.trust?.probe).toMatchObject({
      configuredEnabled: true,
      transport: "stdio",
      trusted: false,
    });
    expect(registered.trust?.user_probe).toBeUndefined();
    expect(registered.trustReasonCode).toBeUndefined();
    expect(registered.unreviewable).toEqual([]);

    // 离线工作区 fail closed：不读项目声明，只返回用户级 MCP + Host 原因。
    const offline = await loadCliMcpFromUserDirectory(
      { workspacePath: workspace },
      { workspaceRegistered: true, online: false, storageRoot },
    );
    expect(offline.servers.map((server) => server.name)).toEqual(["user_probe"]);
    expect(offline.trust).toBeUndefined();
    expect(offline.trustReasonCode).toBe("workspace_mcp_workspace_offline");
  });

  it("returns the user-domain store path reused by the Rust kernel", async () => {
    const storageRoot = await makeRoot("nibi-mcp-trust-path-");
    expect(await resolveWorkspaceMcpTrustStorePath({ storageRoot })).toBe(
      join(storageRoot, "security", "workspace-mcp-trust-v1.json"),
    );
  });
});
