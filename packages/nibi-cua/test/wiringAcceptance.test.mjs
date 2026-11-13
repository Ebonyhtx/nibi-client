/**
 * 接入验收（可选，默认跳过）：**客户端自己的链路**能不能把 Helper 拉起来。
 *
 *   NIBI_CUA_NATIVE_ACCEPTANCE=1 node --import tsx --test test/wiringAcceptance.test.mjs
 *
 * 走 services 的真实工厂（createDefaultCuaProductHelper → resolveWindowsCuaRuntime → host.start），
 * 不是手拼探针；dev 根用 NIBI_CUA_DEV_ROOT（默认指向 <repo>/.staging/tools/cua-helper）。
 * 判据：门控为真、工厂给出 helper、host.start() 后健康检查返回我们的 bundle id、stop 后退出。
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const REPO = join(import.meta.dirname, "..", "..", "..");
const ENABLED = Boolean(process.env.NIBI_CUA_NATIVE_ACCEPTANCE || process.argv.includes("--wiring"));

test("接入：services 工厂能拉起我们的 Helper 并通过健康检查", { skip: !ENABLED }, async () => {
  const devRoot = process.env.NIBI_CUA_DEV_ROOT?.trim() || join(REPO, ".staging", "tools", "cua-helper");
  const servicesNodeUrl = pathToFileURL(join(REPO, "packages", "services", "src", "node.ts")).href;
  const { createDefaultCuaProductHelper, shouldEnableDefaultCuaProductHelper } = await import(servicesNodeUrl);

  const env = { ...process.env, NIBI_CUA_DEV_ROOT: devRoot };
  assert.equal(shouldEnableDefaultCuaProductHelper({ platform: "win32", env }), true, "门控该为真");

  const helper = createDefaultCuaProductHelper({ platform: "win32", env });
  assert.ok(helper, "工厂应给出 helper");
  assert.ok(helper.resolver, "应带 resolver（会话解析 CU MCP 时用它）");
  try {
    await helper.host.start();
    const health = await helper.host.checkHealth();
    assert.match(String(health.bundleId ?? ""), /^nibi-computer-use-/, `健康检查应报我们的 bundle id：${JSON.stringify(health)}`);
    assert.ok(Number.isInteger(health.pid) && health.pid > 0, "健康检查应带 helper pid");
  } finally {
    await helper.host.stop();
  }
});
