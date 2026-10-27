import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountProviderService, ProviderConfigMap } from "@nibi/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderConfigRuntime } from "#src/model-provider/providerConfigRuntime.js";
import { createProviderRuntimeFromConfigRuntime } from "#src/model-provider/providerRuntime.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function setup(active = false) {
  const root = await mkdtemp(join(tmpdir(), "builtin-refresh-failure-"));
  const bundled = join(root, "bundled.json");
  const activePath = join(root, "active.json");
  const release = JSON.parse(
    await readFile(new URL("../../../config/provider/nibi-builtin.json", import.meta.url), "utf8"),
  );
  release.revision = 1;
  await writeFile(bundled, JSON.stringify(release));
  if (active) await writeFile(activePath, JSON.stringify({ ...release, revision: 2 }));
  const download = vi.fn(async () => null);
  const configRuntime = createProviderConfigRuntime({
    nibiBuiltinFilePath: bundled,
    nibiBuiltinActiveFilePath: activePath,
    personalFilePath: join(root, "personal.json"),
    personalPollingIntervalMs: false,
    watch: false,
    nibiBuiltinRemote: {
      controlFilePath: join(root, "refresh.json"),
      resolveEndpointKey: () => "https://control.example.com",
      fetchRelease: download,
    },
  });
  const resolve = vi.fn(async () => ({
    providers: new ProviderConfigMap(),
    states: {},
  }));
  const account = new AccountProviderService({
    configSource: configRuntime.configService,
    resolve,
  });
  const runtime = createProviderRuntimeFromConfigRuntime({
    configRuntime,
    accountSource: account,
    disposeAccountSource: () => account.dispose(),
  });
  cleanups.push(async () => {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.start();
  await configRuntime.refreshZCodeBuiltin();
  return {
    runtime,
    configRuntime,
    bundled,
    activePath,
    download,
    resolve,
  };
}

describe("Builtin 远端失败不阻断有效本地配置的业务刷新", () => {
  // 上游 Team/Start 套餐（account:*-coding-plan）已随套餐业务移除，权益刷新的用例一并删除；
  // 这里保留与套餐无关的两条：远端失败的错误传播与本地 Release 的完整性。
  it("远端和账号同时失败时，返回真实账号错误，不用旧权益伪装成功", async () => {
    const fixture = await setup();
    fixture.download.mockRejectedValue(new Error("remote unavailable"));
    const accountError = new Error("account entitlement unavailable");
    fixture.resolve.mockRejectedValue(accountError);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(fixture.runtime.providerSettings.refresh("composer-connection")).rejects.toBe(
      accountError,
    );
  });

  it("本地 Bundled 与 Active 都不可用时，仍拒绝刷新", async () => {
    const fixture = await setup();
    await writeFile(fixture.bundled, "invalid json");
    await writeFile(fixture.activePath, "invalid json");
    fixture.download.mockRejectedValue(new Error("remote unavailable"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(fixture.runtime.providerSettings.refresh("settings-manual")).rejects.toThrow();
  });
});
