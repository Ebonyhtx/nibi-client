import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMcpSyncService } from "../src/mcp-sync/mcpSyncService.js";

function makeHome() {
  return mkdtempSync(join(tmpdir(), "nibi-mcp-sync-home-"));
}

async function writeNibiUserMcp(
  home: string,
  servers: Record<string, Record<string, unknown>>,
) {
  const configPath = join(home, ".nibi", "cli", "config.json");
  await mkdir(join(home, ".nibi", "cli"), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({ mcp: { servers } }, null, 2)}\n`,
  );
  return configPath;
}

async function writeAgentsUserMcp(
  home: string,
  servers: Record<string, Record<string, unknown>>,
) {
  const configPath = join(home, ".agents", "mcp.json");
  await mkdir(join(home, ".agents"), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
  );
  return configPath;
}

async function readRemoteNibiServers(home: string) {
  const raw = await readFile(join(home, ".nibi", "cli", "config.json"), "utf-8");
  const parsed = JSON.parse(raw) as {
    mcp?: { servers?: Record<string, Record<string, unknown>> };
  };
  return parsed.mcp?.servers ?? {};
}

describe("mcp sync service", () => {
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
  });

  it("lists user zcode MCP servers as local candidates", async () => {
    const home = makeHome();
    process.env.HOME = home;
    await writeNibiUserMcp(home, {
      context7: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      },
    });
    const service = createMcpSyncService();

    const result = await service.listLocalUserMcpCandidates();

    expect(result.localHomeDir).toBe(home);
    expect(result.candidates).toMatchObject([
      {
        name: "context7",
        enabled: true,
        source: "nibi",
        path: join(home, ".nibi", "cli", "config.json"),
        config: {
          command: "npx",
          args: ["-y", "@upstash/context7-mcp"],
        },
      },
    ]);
  });

  it("marks a candidate disabled when only enabled:false is present", async () => {
    const home = makeHome();
    process.env.HOME = home;
    // 外部工具/手工编辑写的是 enabled:false；同步侧不能把它当成启用状态。
    await writeNibiUserMcp(home, {
      context7: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        enabled: false,
      },
    });
    const service = createMcpSyncService();

    const result = await service.listLocalUserMcpCandidates();

    expect(result.candidates[0]).toMatchObject({ name: "context7", enabled: false });
  });

  it("clears a stale enabled flag when toggling a server", async () => {
    const home = makeHome();
    process.env.HOME = home;
    // 线上配置里 enable 与 enabled 并存，切换开关后不能再留下自相矛盾的字段。
    await writeNibiUserMcp(home, {
      context7: {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        enabled: true,
      },
    });
    const service = createMcpSyncService();

    await service.saveMcpToUserDirectory({
      action: "set-enabled",
      source: "zcodeagentmcp",
      name: "context7",
      enabled: false,
    });

    expect((await readRemoteNibiServers(home)).context7).toEqual({
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      enabled: false,
    });

    await service.saveMcpToUserDirectory({
      action: "set-enabled",
      source: "zcodeagentmcp",
      name: "context7",
      enabled: true,
    });

    expect((await readRemoteNibiServers(home)).context7).toEqual({
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
    });
  });

  it("migrates a legacy enable flag to enabled when listing candidates", async () => {
    const home = makeHome();
    process.env.HOME = home;
    // 存量配置只有桌面端历史写入的 enable；同步侧读取时应就地迁移成契约字段 enabled。
    await writeNibiUserMcp(home, {
      context7: {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        enable: false,
      },
    });
    const service = createMcpSyncService();

    const result = await service.listLocalUserMcpCandidates();

    expect(result.candidates[0]).toMatchObject({ name: "context7", enabled: false });
    expect((await readRemoteNibiServers(home)).context7).toEqual({
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      enabled: false,
    });
  });

  it("keeps a candidate disabled when legacy enable:false collides with enabled:true", async () => {
    const home = makeHome();
    process.env.HOME = home;
    // 线上事故配置：停用写了 enable:false，但外部导入残留 enabled:true。迁移必须保住停用语义。
    await writeNibiUserMcp(home, {
      context7: {
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        enable: false,
        enabled: true,
      },
    });
    const service = createMcpSyncService();

    const result = await service.listLocalUserMcpCandidates();

    expect(result.candidates[0]).toMatchObject({ name: "context7", enabled: false });
    expect((await readRemoteNibiServers(home)).context7).toEqual({
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      enabled: false,
    });
  });

  it("leaves the config file untouched when no legacy enable flag exists", async () => {
    const home = makeHome();
    process.env.HOME = home;
    // 迁移必须幂等：没有残留字段时不能重写文件，否则每次列举候选都会动用户的配置。
    // 故意用非规范化的紧凑 JSON 落盘，任何重写都会改变字节内容。
    const configPath = join(home, ".nibi", "cli", "config.json");
    await mkdir(join(home, ".nibi", "cli"), { recursive: true });
    const raw = JSON.stringify({
      mcp: {
        servers: {
          context7: {
            command: "npx",
            args: ["-y", "@upstash/context7-mcp"],
            enabled: false,
          },
        },
      },
    });
    await writeFile(configPath, raw);
    const service = createMcpSyncService();

    await service.listLocalUserMcpCandidates();

    await expect(readFile(configPath, "utf-8")).resolves.toBe(raw);
  });

  it("checks remote MCP config directory write access before sync", async () => {
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const service = createMcpSyncService();

    const result = await service.checkRemoteUserMcpWriteAccess();

    expect(result).toMatchObject({
      ok: true,
      path: join(remoteHome, ".nibi", "cli"),
    });
  });

  it("reports remote MCP write preflight failure when cli path is not a directory", async () => {
    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await mkdir(join(remoteHome, ".nibi"), { recursive: true });
    await writeFile(join(remoteHome, ".nibi", "cli"), "not a directory");
    const service = createMcpSyncService();

    const result = await service.checkRemoteUserMcpWriteAccess();

    expect(result.ok).toBe(false);
    expect(result.path).toBe(join(remoteHome, ".nibi", "cli"));
    expect(result.error).toBeTruthy();
  });

  it("falls back to user agents MCP servers when zcode user MCP is empty", async () => {
    const home = makeHome();
    process.env.HOME = home;
    await writeAgentsUserMcp(home, {
      docs: {
        type: "http",
        url: "https://mcp.example.com/mcp",
      },
    });
    const service = createMcpSyncService();

    const result = await service.listLocalUserMcpCandidates();

    expect(result.candidates).toMatchObject([
      {
        name: "docs",
        source: "agents",
        path: join(home, ".agents", "mcp.json"),
      },
    ]);
  });

  it("imports stdio and HTTP MCP servers while preserving secrets", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    await writeNibiUserMcp(localHome, {
      context7: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
        env: { CONTEXT7_API_KEY: "secret-local" },
      },
      docsApi: {
        type: "http",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer secret-token" },
      },
    });
    const localService = createMcpSyncService();
    const candidates = await localService.listLocalUserMcpCandidates();
    const exported = await localService.exportMcpServers({
      serverIds: candidates.candidates.map((candidate) => candidate.id),
    });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const remoteService = createMcpSyncService();
    const result = await remoteService.importMcpServers({
      servers: exported.servers,
      localHomeDir: exported.localHomeDir,
      remoteWorkspacePath: "/home/dev/project",
      overwrite: false,
    });

    expect(result.results).toMatchObject([
      { name: "context7", status: "synced" },
      { name: "docsApi", status: "synced" },
    ]);
    const remoteServers = await readRemoteNibiServers(remoteHome);
    expect(remoteServers.context7).toMatchObject({
      command: "npx",
      args: ["-y", "@upstash/context7-mcp"],
      env: { CONTEXT7_API_KEY: "secret-local" },
    });
    expect(remoteServers.docsApi).toMatchObject({
      url: "https://mcp.example.com/mcp",
      headers: { Authorization: "Bearer secret-token" },
    });
  });

  it("creates imported remote MCP config with owner-only permissions", async () => {
    if (process.platform === "win32") {
      return;
    }

    const previousUmask = process.umask(0o000);
    try {
      const remoteHome = makeHome();
      process.env.HOME = remoteHome;
      const remoteService = createMcpSyncService();

      await remoteService.importMcpServers({
        servers: [
          {
            id: "docs-api",
            name: "docsApi",
            source: "nibi",
            path: "/Users/local/.nibi/cli/config.json",
            enabled: true,
            config: {
              type: "http",
              url: "https://mcp.example.com/mcp",
              headers: { Authorization: "Bearer secret-token" },
            },
          },
        ],
        localHomeDir: "/Users/local",
        overwrite: false,
      });

      const configMode = (await stat(join(remoteHome, ".nibi", "cli", "config.json")))
        .mode;
      expect(configMode & 0o777).toBe(0o600);
    } finally {
      process.umask(previousUmask);
    }
  });

  it("fails remote import without overwriting an invalid zcode config file", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    await writeNibiUserMcp(localHome, {
      context7: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      },
    });
    const localService = createMcpSyncService();
    const candidates = await localService.listLocalUserMcpCandidates();
    const exported = await localService.exportMcpServers({
      serverIds: candidates.candidates.map((candidate) => candidate.id),
    });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const invalidConfigPath = join(remoteHome, ".nibi", "cli", "config.json");
    await mkdir(join(remoteHome, ".nibi", "cli"), { recursive: true });
    await writeFile(invalidConfigPath, '{"mcp":');
    const remoteService = createMcpSyncService();

    await expect(
      remoteService.importMcpServers({
        servers: exported.servers,
        localHomeDir: exported.localHomeDir,
        remoteWorkspacePath: "/home/dev/project",
        overwrite: false,
      }),
    ).rejects.toThrow(/config\.json/);
    await expect(readFile(invalidConfigPath, "utf-8")).resolves.toBe('{"mcp":');
  });

  it("loads and saves user MCP through the service on the current host", async () => {
    const home = makeHome();
    process.env.HOME = home;
    const service = createMcpSyncService();

    await service.saveMcpToUserDirectory({
      action: "upsert",
      source: "zcodeagentmcp",
      name: "deepwiki",
      config: {
        type: "http",
        url: "https://mcp.deepwiki.com/mcp",
      },
    });

    const result = await service.loadMcpFromUserDirectory();

    expect(result.servers).toMatchObject([
      {
        source: "zcodeagentmcp",
        scope: "user",
        name: "deepwiki",
        config: {
          type: "http",
          url: "https://mcp.deepwiki.com/mcp",
        },
      },
    ]);
    expect(result.servers[0]?.file?.filePath).toBe(
      join(home, ".nibi", "cli", "config.json"),
    );
  });

  it("loads workspace MCP before user MCP using the same directory precedence", async () => {
    const home = makeHome();
    const workspace = join(home, "workspace");
    process.env.HOME = home;
    await writeNibiUserMcp(home, {
      userOnly: { type: "http", url: "https://user.example.test/mcp" },
    });
    await mkdir(join(workspace, ".nibi"), { recursive: true });
    await writeFile(
      join(workspace, ".nibi", "config.json"),
      JSON.stringify(
        {
          mcp: {
            servers: {
              workspaceOnly: {
                type: "http",
                url: "https://workspace.example.test/mcp",
              },
            },
          },
        },
        null,
        2,
      ),
    );
    const service = createMcpSyncService();

    const result = await service.loadMcpFromUserDirectory({ workspacePath: workspace });

    expect(result.servers.map((server) => `${server.scope}:${server.name}`)).toEqual([
      "workspace:workspaceOnly",
      "user:userOnly",
    ]);
  });

  it("rewrites filesystem MCP home and workspace paths for the remote host", async () => {
    const localHome = makeHome();
    const localWorkspacePath = join(localHome, "workspace", "z-code");
    process.env.HOME = localHome;
    await writeNibiUserMcp(localHome, {
      filesystem: {
        type: "stdio",
        command: "npx",
        args: [
          "-y",
          "@modelcontextprotocol/server-filesystem",
          join(localWorkspacePath, "src"),
          join(localHome, "Documents"),
        ],
      },
    });
    const localService = createMcpSyncService();
    const candidates = await localService.listLocalUserMcpCandidates();
    const exported = await localService.exportMcpServers({
      serverIds: candidates.candidates.map((candidate) => candidate.id),
    });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    const remoteService = createMcpSyncService();
    await remoteService.importMcpServers({
      servers: exported.servers,
      localHomeDir: exported.localHomeDir,
      localWorkspacePath,
      remoteWorkspacePath: "/srv/z-code",
      overwrite: false,
    });

    const remoteServers = await readRemoteNibiServers(remoteHome);
    expect(remoteServers.filesystem?.args).toEqual([
      "-y",
      "@modelcontextprotocol/server-filesystem",
      "/srv/z-code/src",
      join(remoteHome, "Documents"),
    ]);
  });

  it("skips same-name remote MCP servers without overwriting", async () => {
    const localHome = makeHome();
    process.env.HOME = localHome;
    await writeNibiUserMcp(localHome, {
      context7: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@upstash/context7-mcp"],
      },
    });
    const localService = createMcpSyncService();
    const candidates = await localService.listLocalUserMcpCandidates();
    const exported = await localService.exportMcpServers({
      serverIds: candidates.candidates.map((candidate) => candidate.id),
    });

    const remoteHome = makeHome();
    process.env.HOME = remoteHome;
    await writeNibiUserMcp(remoteHome, {
      context7: {
        type: "stdio",
        command: "existing-command",
      },
    });
    const remoteService = createMcpSyncService();

    const result = await remoteService.importMcpServers({
      servers: exported.servers,
      localHomeDir: exported.localHomeDir,
      remoteWorkspacePath: "/home/dev/project",
      overwrite: false,
    });

    expect(result.results).toEqual([
      {
        name: "context7",
        status: "skipped",
        path: join(remoteHome, ".nibi", "cli", "config.json"),
      },
    ]);
    const remoteServers = await readRemoteNibiServers(remoteHome);
    expect(remoteServers.context7).toMatchObject({
      command: "existing-command",
    });
  });
});

describe("mcp sync config write hardening", () => {
  it("拒绝覆盖损坏的用户 config，文件字节保持不变", async () => {
    const home = makeHome();
    process.env.HOME = home;
    const configPath = join(home, ".nibi", "cli", "config.json");
    await mkdir(join(home, ".nibi", "cli"), { recursive: true });
    const broken = '{"mcp":{"servers":';
    await writeFile(configPath, broken);

    const service = createMcpSyncService();
    await expect(
      service.saveMcpToUserDirectory({
        action: "upsert",
        source: "zcodeagentmcp",
        name: "deepwiki",
        config: { type: "http", url: "https://mcp.deepwiki.com/mcp" },
      }),
    ).rejects.toThrow(/not valid JSON/);

    await expect(readFile(configPath, "utf-8")).resolves.toBe(broken);
  });

  it("写 MCP server 时保留其他写入方字段", async () => {
    const home = makeHome();
    process.env.HOME = home;
    const configPath = join(home, ".nibi", "cli", "config.json");
    await mkdir(join(home, ".nibi", "cli"), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        provider: { default: "glm" },
        command: { "/c.md": { enable: false } },
        mcp: { servers: { existing: { type: "http", url: "https://existing.test/mcp" } } },
      }),
    );

    const service = createMcpSyncService();
    await service.saveMcpToUserDirectory({
      action: "upsert",
      source: "zcodeagentmcp",
      name: "deepwiki",
      config: { type: "http", url: "https://mcp.deepwiki.com/mcp" },
    });

    const saved = JSON.parse(await readFile(configPath, "utf-8")) as {
      provider?: unknown;
      command?: unknown;
      mcp?: { servers?: Record<string, unknown> };
    };
    expect(saved.provider).toEqual({ default: "glm" });
    expect(saved.command).toEqual({ "/c.md": { enable: false } });
    expect(Object.keys(saved.mcp?.servers ?? {}).sort()).toEqual(["deepwiki", "existing"]);
  });
});

describe("mcp sync workspace trust", () => {
  it("workspace load 回传 trust review，decide 写入该 Environment 的信任库", async () => {
    const home = makeHome();
    const workspace = join(home, "workspace");
    const originalStorage = process.env.NIBI_STORAGE_DIR;
    process.env.HOME = home;
    delete process.env.NIBI_STORAGE_DIR;
    try {
      await mkdir(join(workspace, ".nibi"), { recursive: true });
      await writeFile(
        join(workspace, ".nibi", "config.json"),
        JSON.stringify({
          mcp: { servers: { probe: { type: "stdio", command: "node", args: ["probe.mjs"] } } },
        }),
      );
      const service = createMcpSyncService();
      const identity = "/remote/workspaces/project";

      const loaded = await service.loadMcpFromUserDirectory({
        workspacePath: workspace,
        workspaceIdentity: identity,
      });
      const review = loaded.trust?.probe;
      expect(review).toMatchObject({
        trusted: false,
        configuredEnabled: true,
        transport: "stdio",
      });
      expect(review?.declarationDigest).toMatch(/^[a-f0-9]{64}$/u);
      expect(loaded.unreviewable ?? []).toEqual([]);

      // 远端 UI 只有拿到该方法才会展示审批按钮；旧远端 Host 保持“未知”兼容语义。
      await expect(
        service.decideWorkspaceMcpTrust!({
          workspacePath: workspace,
          workspaceIdentity: identity,
          serverName: "probe",
          declarationDigest: review!.declarationDigest,
          trusted: true,
        }),
      ).resolves.toEqual({ accepted: true });

      const reloaded = await service.loadMcpFromUserDirectory({
        workspacePath: workspace,
        workspaceIdentity: identity,
      });
      expect(reloaded.trust?.probe?.trusted).toBe(true);
      await expect(
        readFile(join(home, ".nibi", "security", "workspace-mcp-trust-v1.json"), "utf-8"),
      ).resolves.toContain(review!.declarationDigest);
    } finally {
      if (originalStorage === undefined) delete process.env.NIBI_STORAGE_DIR;
      else process.env.NIBI_STORAGE_DIR = originalStorage;
    }
  });

  it("workspace 声明变化后旧授权失效，旧 digest 决定被拒绝", async () => {
    const home = makeHome();
    const workspace = join(home, "workspace");
    const originalStorage = process.env.NIBI_STORAGE_DIR;
    process.env.HOME = home;
    delete process.env.NIBI_STORAGE_DIR;
    try {
      const configPath = join(workspace, ".nibi", "config.json");
      const identity = "/remote/workspaces/project";
      await mkdir(join(workspace, ".nibi"), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({ mcp: { servers: { probe: { type: "stdio", command: "node" } } } }),
      );
      const service = createMcpSyncService();
      const first = await service.loadMcpFromUserDirectory({
        workspacePath: workspace,
        workspaceIdentity: identity,
      });
      const oldDigest = first.trust!.probe!.declarationDigest;
      await service.decideWorkspaceMcpTrust!({
        workspacePath: workspace,
        workspaceIdentity: identity,
        serverName: "probe",
        declarationDigest: oldDigest,
        trusted: true,
      });

      await writeFile(
        configPath,
        JSON.stringify({
          mcp: { servers: { probe: { type: "stdio", command: "node", args: ["v2.mjs"] } } },
        }),
      );
      const changed = await service.loadMcpFromUserDirectory({
        workspacePath: workspace,
        workspaceIdentity: identity,
      });
      expect(changed.trust?.probe).toMatchObject({
        trusted: false,
        declarationChanged: true,
      });
      await expect(
        service.decideWorkspaceMcpTrust!({
          workspacePath: workspace,
          workspaceIdentity: identity,
          serverName: "probe",
          declarationDigest: oldDigest,
          trusted: true,
        }),
      ).resolves.toEqual({
        accepted: false,
        reasonCode: "workspace_mcp_declaration_changed",
      });
    } finally {
      if (originalStorage === undefined) delete process.env.NIBI_STORAGE_DIR;
      else process.env.NIBI_STORAGE_DIR = originalStorage;
    }
  });
});
