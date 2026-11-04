import { beforeEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(() => ({
  addPluginMarketplace: vi.fn(),
  configurePlugin: vi.fn(),
  describePlugin: vi.fn(),
  getPluginsOverview: vi.fn(),
  installPlugin: vi.fn(),
  listPluginUiSurfaces: vi.fn(),
  listPlugins: vi.fn(),
  removePluginMarketplace: vi.fn(),
  resetPluginConfig: vi.fn(),
  restoreBuiltinPlugin: vi.fn(),
  setPluginEnabled: vi.fn(),
  toPluginInfo: vi.fn(),
  uninstallPlugin: vi.fn(),
  updatePlugin: vi.fn(),
  updatePluginMarketplace: vi.fn(),
  validatePlugin: vi.fn(),
}));

vi.mock("@nibi/bootstrap/plugin-management", () => handlers);
vi.mock("@nibi/services/node", () => ({
  createServiceLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

import {
  createLocalPluginManagementBackend,
  createLocalPluginManagementService,
} from "../src/host/localPluginManagementService.js";

function fallback() {
  return {
    getPluginReferenceCatalog: vi.fn(),
    onDynamicPluginOperationProgress: vi.fn(),
    resolveSuggestedPluginReference: vi.fn(),
  };
}

function service(withFallback = fallback()) {
  return {
    fallback: withFallback,
    value: createLocalPluginManagementService({
      env: {},
      fallback: withFallback as never,
    }),
  };
}

describe("local plugin management service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes the workspace authority and config scope to the shared list handler", async () => {
    handlers.listPlugins.mockResolvedValue({ diagnostics: [], plugins: [] });
    const { value } = service();

    await value.listPlugins({
      configScope: "workspace",
      workspaceIdentity: "workspace-id",
      workspacePath: "D:/work/project",
    });

    expect(handlers.listPlugins).toHaveBeenCalledTimes(1);
    const [context, params] = handlers.listPlugins.mock.calls[0]!;
    expect(context).toMatchObject({ deps: { env: {} } });
    expect(params).toMatchObject({
      configScope: "workspace",
      workspace: {
        workspaceIdentity: "workspace-id",
        workspaceKey: "workspace-id",
        workspacePath: "D:/work/project",
      },
    });
  });

  it("maps optional install fields without inventing defaults", async () => {
    handlers.installPlugin.mockResolvedValue({
      dependencyClosure: [],
      diagnostics: [],
      installedPlugins: [],
    });
    const { value } = service();

    await value.installPlugin({
      marketplace: "nibi-official",
      pluginName: "browser-use",
      workspacePath: "D:/work/project",
    });

    const [, params] = handlers.installPlugin.mock.calls[0]!;
    expect(params).toMatchObject({
      marketplace: "nibi-official",
      pluginName: "browser-use",
      workspace: { workspacePath: "D:/work/project", workspaceKey: "D:/work/project" },
    });
    expect(params).not.toHaveProperty("dryRun");
    expect(params).not.toHaveProperty("scope");
  });

  it("aborts the in-flight operation and reports it cancelled", async () => {
    let signal: AbortSignal | undefined;
    handlers.setPluginEnabled.mockImplementation(
      (_context: unknown, _params: unknown, incoming?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal = incoming;
          incoming?.addEventListener("abort", () => reject(incoming.reason), { once: true });
        }),
    );
    const { value } = service();

    const pending = value.setPluginEnabled({
      enabled: true,
      operationId: "op-1",
      pluginId: "browser-use@nibi-official",
      workspacePath: "D:/work/project",
    });
    await Promise.resolve();

    await expect(value.cancelPluginOperation({ operationId: "op-1" })).resolves.toEqual({
      cancelled: true,
      operationId: "op-1",
    });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(signal?.aborted).toBe(true);
  });

  it("reports an unknown operation as not cancelled", async () => {
    const { value } = service();

    await expect(value.cancelPluginOperation({ operationId: "missing" })).resolves.toEqual({
      cancelled: false,
      operationId: "missing",
    });
  });

  it("keeps session-owned reference catalog on the agent/kernel fallback", async () => {
    const withFallback = fallback();
    withFallback.getPluginReferenceCatalog.mockResolvedValue({
      authority: "session",
      plugins: [],
    });
    const { value } = service(withFallback);

    const params = {
      sessionId: "session-1",
      workspacePath: "D:/work/project",
    };
    await expect(value.getPluginReferenceCatalog(params)).resolves.toEqual({
      authority: "session",
      plugins: [],
    });
    expect(withFallback.getPluginReferenceCatalog).toHaveBeenCalledWith(params);
    expect(handlers.listPlugins).not.toHaveBeenCalled();
  });

  it("does not send remove-marketplace through the fallback", async () => {
    handlers.removePluginMarketplace.mockResolvedValue({ diagnostics: [] });
    const withFallback = fallback();
    const { value } = service(withFallback);

    await value.removePluginMarketplace({
      marketplace: "community",
      workspacePath: "D:/work/project",
    });

    expect(handlers.removePluginMarketplace).toHaveBeenCalledTimes(1);
    expect(withFallback.getPluginReferenceCatalog).not.toHaveBeenCalled();
  });

  it("exposes the workspace-level UI surfaces projection beside the service", async () => {
    handlers.listPluginUiSurfaces.mockResolvedValue({ surfaces: [] });
    const withFallback = fallback();
    const backend = createLocalPluginManagementBackend({
      env: {},
      fallback: withFallback as never,
    });

    await backend.listPluginUiSurfaces({
      workspaceIdentity: "workspace-id",
      workspacePath: "D:/work/project",
    });

    expect(handlers.listPluginUiSurfaces).toHaveBeenCalledTimes(1);
    const [, params] = handlers.listPluginUiSurfaces.mock.calls[0]!;
    expect(params).toMatchObject({
      workspace: {
        workspaceIdentity: "workspace-id",
        workspaceKey: "workspace-id",
        workspacePath: "D:/work/project",
      },
    });
  });
});
