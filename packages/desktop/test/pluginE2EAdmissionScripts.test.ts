import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const desktopDir = resolve(repoRoot, "packages/desktop");
const pendingProbeCase = "plugin-promotion-probe";
const pendingSpec = `./packages/desktop/test/e2e/plugins/manual-review/pending/${pendingProbeCase}.test.ts`;
const pendingProbeSpec = resolve(
  desktopDir,
  "test/e2e/plugins/manual-review/pending",
  `${pendingProbeCase}.test.ts`,
);
const pendingProbeFixture = resolve(
  desktopDir,
  "test/e2e/fixtures/upstream/plugin-management",
  `${pendingProbeCase}.json`,
);
const pendingProbeManifest = resolve(
  desktopDir,
  "test/e2e/fixtures/cases/plugins",
  `${pendingProbeCase}.json`,
);
const manualOnlySpec =
  "./packages/desktop/test/e2e/plugins/manual-review/pending/plugin-cdn-zip-official-cdn-smoke.test.ts";
const fixtureCheckCase = "plugin-fixture-check-probe";
const formalProbeSpec = resolve(desktopDir, "test/e2e/plugins", `${fixtureCheckCase}.test.ts`);
const formalProbeFixture = resolve(
  desktopDir,
  "test/e2e/fixtures/upstream/plugin-management",
  `${fixtureCheckCase}.json`,
);
const formalProbeManifest = resolve(
  desktopDir,
  "test/e2e/fixtures/cases/plugins",
  `${fixtureCheckCase}.json`,
);

beforeAll(() => {
  // 修复原因：真实 pending 用例会随复核持续转正，不能把它当作脚本探针；探针必须
  // 由测试自己创建，才能长期验证“pending 可预览、apply 必须 --reviewed”的合同。
  writeProbeFile(
    pendingProbeSpec,
    'describe("E2E_PLUGIN_PROMOTION_PROBE", () => {});\n',
  );
  writeProbeFile(
    pendingProbeFixture,
    `${JSON.stringify(
      {
        version: 1,
        caseName: pendingProbeCase,
        spec: `./test/e2e/plugins/manual-review/pending/${pendingProbeCase}.test.ts`,
        fixtures: [],
      },
      null,
      2,
    )}\n`,
  );
  writeProbeFile(
    pendingProbeManifest,
    `${JSON.stringify(
      {
        version: 1,
        caseName: pendingProbeCase,
        spec: `./test/e2e/plugins/manual-review/pending/${pendingProbeCase}.test.ts`,
        providerFixtures: [],
        requests: [],
      },
      null,
      2,
    )}\n`,
  );
  writeProbeFile(formalProbeSpec, 'describe("E2E_PLUGIN_FIXTURE_CHECK_PROBE", () => {});\n');
  writeProbeFile(
    formalProbeFixture,
    `${JSON.stringify(
      {
        version: 1,
        // 修复原因：pending 与 formal 共用 canonical fixture identity，probe 也必须模拟完整合同。
        caseName: fixtureCheckCase,
        spec: `./test/e2e/plugins/${fixtureCheckCase}.test.ts`,
        fixtures: [
          {
            id: fixtureCheckCase,
            match: {
              method: "POST",
              pathIncludes: "/messages",
              bodyIncludes: ["E2E_PLUGIN_FIXTURE_CHECK_PROBE"],
            },
            response: { statusCode: 200, text: "ok" },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeProbeFile(
    formalProbeManifest,
    `${JSON.stringify(
      {
        version: 1,
        caseName: fixtureCheckCase,
        spec: `./test/e2e/plugins/${fixtureCheckCase}.test.ts`,
        providerFixtures: [
          "./test/e2e/fixtures/upstream/common.json",
          `./test/e2e/fixtures/upstream/plugin-management/${fixtureCheckCase}.json`,
        ],
        requests: [
          {
            id: fixtureCheckCase,
            kind: "main",
            source: "synthetic",
            syntheticReason:
              "Exercise plugin fixture-check routing without a promoted product case.",
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
});

afterAll(() => {
  rmSync(pendingProbeSpec, { force: true });
  rmSync(pendingProbeFixture, { force: true });
  rmSync(pendingProbeManifest, { force: true });
  rmSync(formalProbeSpec, { force: true });
  rmSync(formalProbeFixture, { force: true });
  rmSync(formalProbeManifest, { force: true });
});

describe("plugin lifecycle E2E admission scripts", () => {
  it("dry-runs promotion but requires explicit human review before applying", () => {
    const dryRun = runScript("promote-plugin-e2e.mjs", ["--spec", pendingSpec]);
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain("Dry run plugin E2E promotion");
    expect(dryRun.stdout).toContain(
      "Do not apply until screenshots and behavior have passed human review",
    );

    const unreviewedApply = runScript("promote-plugin-e2e.mjs", ["--spec", pendingSpec, "--apply"]);
    expect(unreviewedApply.status).toBe(1);
    expect(unreviewedApply.stdout).toContain("Use --reviewed when applying plugin promotion");
  });

  it("rejects Docker admission for a pending manual-review spec", () => {
    const result = runScript("admit-plugin-e2e-docker.mjs", ["--spec", pendingSpec]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Spec must be a promoted formal plugin case");
  });

  it("routes promoted plugin specs to plugin case manifests and fixtures", () => {
    const result = runScript("check-e2e-fixtures.mjs", ["--spec", formalProbeSpec]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Case: ${fixtureCheckCase}`);
    expect(result.stdout).toContain("Fixture check passed");
  });

  it("never promotes the real official CDN manual smoke", () => {
    const result = runScript("promote-plugin-e2e.mjs", ["--spec", manualOnlySpec, "--reviewed"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("manual-only and cannot be promoted");
  });
});

function runScript(scriptName: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [resolve(repoRoot, "packages/desktop/scripts", scriptName), ...args],
    { cwd: repoRoot, encoding: "utf-8" },
  );
}

function writeProbeFile(path: string, content: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, content, "utf-8");
}
