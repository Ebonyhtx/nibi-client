import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PLUGIN_CONSENT_FILE,
  backfillPluginConsentHash,
  pluginConsentCovers,
  readPluginConsents,
  readRecentPluginAuditEvents,
  resetPluginAuditPruneThrottleForTests,
  resolvePluginContentTrust,
  writePluginConsent,
} from "../src/plugins/helpers.js";
import type { PluginPermission } from "@nibi/contracts";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;
const REQUIRED: PluginPermission[] = ["process", "network"];

const roots: string[] = [];

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function writeRawConsent(root: string, plugins: Record<string, unknown>): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, PLUGIN_CONSENT_FILE),
    `${JSON.stringify({ plugins, version: 1 }, null, 2)}\n`,
    "utf8",
  );
}

function auditCount(root: string): number {
  return readRecentPluginAuditEvents(root, 1000).length;
}

beforeEach(() => {
  resetPluginAuditPruneThrottleForTests();
});

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("consent package hash binding", () => {
  it("stores and reads back a valid package hash", () => {
    const root = makeRoot("nibi-consent-hash-");
    writePluginConsent({
      packageHash: HASH_A,
      permissions: REQUIRED,
      pluginId: "demo@inline",
      storageRoot: root,
      version: "1.0.0",
    });

    const record = readPluginConsents(root).plugins["demo@inline"];
    expect(record?.packageHash).toBe(HASH_A);
    expect(record?.version).toBe("1.0.0");
  });

  it("drops an invalid package hash when reading", () => {
    const root = makeRoot("nibi-consent-bad-hash-");
    writeRawConsent(root, {
      "demo@inline": {
        grantedAt: "2026-11-01T00:00:00.000Z",
        packageHash: "sha256:not-a-hex-digest",
        permissions: ["process"],
        version: "1.0.0",
      },
    });

    const record = readPluginConsents(root).plugins["demo@inline"];
    expect(record).toBeDefined();
    expect(record?.packageHash).toBeUndefined();
    expect(record?.permissions).toEqual(["process"]);
  });

  it("ignores an invalid package hash passed to writePluginConsent", () => {
    const root = makeRoot("nibi-consent-write-bad-");
    writePluginConsent({
      packageHash: "md5:whatever",
      permissions: ["process"],
      pluginId: "demo@inline",
      storageRoot: root,
      version: "1.0.0",
    });

    expect(readPluginConsents(root).plugins["demo@inline"]?.packageHash).toBeUndefined();
  });

  it("pluginConsentCovers applies version, permission and hash rules", () => {
    const bound = {
      grantedAt: "2026-11-01T00:00:00.000Z",
      packageHash: HASH_A,
      permissions: REQUIRED,
      version: "1.0.0",
    };
    const legacy = { ...bound, packageHash: undefined };

    expect(pluginConsentCovers(undefined, "1.0.0", REQUIRED)).toBe(false);
    expect(pluginConsentCovers(bound, "2.0.0", REQUIRED)).toBe(false);
    expect(pluginConsentCovers(bound, "1.0.0", ["process", "code"])).toBe(false);
    expect(pluginConsentCovers(bound, "1.0.0", REQUIRED)).toBe(true);
    expect(pluginConsentCovers(bound, "1.0.0", REQUIRED, HASH_A)).toBe(true);
    // 同版本换内容 → 不覆盖。
    expect(pluginConsentCovers(bound, "1.0.0", REQUIRED, HASH_B)).toBe(false);
    // 旧记录没有 hash：迁移期视为覆盖。
    expect(pluginConsentCovers(legacy, "1.0.0", REQUIRED, HASH_B)).toBe(true);
  });

  it("backfills a legacy record without writing audit events", () => {
    const root = makeRoot("nibi-consent-backfill-");
    writePluginConsent({
      permissions: REQUIRED,
      pluginId: "demo@inline",
      storageRoot: root,
      version: "1.0.0",
    });
    expect(auditCount(root)).toBe(1);

    expect(
      backfillPluginConsentHash({
        at: "2026-11-20T00:00:00.000Z",
        packageHash: HASH_A,
        pluginId: "demo@inline",
        storageRoot: root,
        version: "1.0.0",
      }),
    ).toBe(true);

    const record = readPluginConsents(root).plugins["demo@inline"];
    expect(record?.packageHash).toBe(HASH_A);
    // grantedAt 不变，且补写不触发审计。
    expect(record?.grantedAt).not.toBe("2026-11-20T00:00:00.000Z");
    expect(auditCount(root)).toBe(1);
  });

  it("backfill refuses missing, version-mismatched, already-bound or invalid inputs", () => {
    const root = makeRoot("nibi-consent-backfill-refuse-");
    expect(
      backfillPluginConsentHash({
        packageHash: HASH_A,
        pluginId: "missing@inline",
        storageRoot: root,
        version: "1.0.0",
      }),
    ).toBe(false);

    writePluginConsent({
      permissions: REQUIRED,
      pluginId: "demo@inline",
      storageRoot: root,
      version: "1.0.0",
    });
    expect(
      backfillPluginConsentHash({
        packageHash: HASH_A,
        pluginId: "demo@inline",
        storageRoot: root,
        version: "2.0.0",
      }),
    ).toBe(false);
    expect(
      backfillPluginConsentHash({
        packageHash: "not-a-hash",
        pluginId: "demo@inline",
        storageRoot: root,
        version: "1.0.0",
      }),
    ).toBe(false);

    expect(
      backfillPluginConsentHash({
        packageHash: HASH_A,
        pluginId: "demo@inline",
        storageRoot: root,
        version: "1.0.0",
      }),
    ).toBe(true);
    // 已有绑定不覆盖。
    expect(
      backfillPluginConsentHash({
        packageHash: HASH_B,
        pluginId: "demo@inline",
        storageRoot: root,
        version: "1.0.0",
      }),
    ).toBe(false);
    expect(readPluginConsents(root).plugins["demo@inline"]?.packageHash).toBe(HASH_A);
  });

  it("resolvePluginContentTrust falls back to consentCovers when hash binding is off", () => {
    const root = makeRoot("nibi-consent-resolve-off-");
    expect(
      resolvePluginContentTrust({
        pluginId: "demo@inline",
        requiredPermissions: REQUIRED,
        requireHashBound: false,
        storageRoot: root,
        version: "1.0.0",
      }),
    ).toEqual({ allowed: false, reason: "consent_missing" });

    writePluginConsent({
      permissions: REQUIRED,
      pluginId: "demo@inline",
      storageRoot: root,
      version: "1.0.0",
    });
    // 旧记录 + 当前 hash：requireHashBound=false 仍按覆盖处理。
    expect(
      resolvePluginContentTrust({
        packageHash: HASH_B,
        pluginId: "demo@inline",
        requiredPermissions: REQUIRED,
        requireHashBound: false,
        storageRoot: root,
        version: "1.0.0",
      }),
    ).toEqual({ allowed: true });
  });

  it("resolvePluginContentTrust enforces the bound hash when required", () => {
    const root = makeRoot("nibi-consent-resolve-on-");
    writePluginConsent({
      packageHash: HASH_A,
      permissions: REQUIRED,
      pluginId: "demo@inline",
      storageRoot: root,
      version: "1.0.0",
    });

    expect(
      resolvePluginContentTrust({
        packageHash: HASH_A,
        pluginId: "demo@inline",
        requiredPermissions: REQUIRED,
        requireHashBound: true,
        storageRoot: root,
        version: "1.0.0",
      }),
    ).toEqual({ allowed: true });

    // 同版本换了内容 → hash_mismatch，要求重新确认。
    expect(
      resolvePluginContentTrust({
        packageHash: HASH_B,
        pluginId: "demo@inline",
        requiredPermissions: REQUIRED,
        requireHashBound: true,
        storageRoot: root,
        version: "1.0.0",
      }),
    ).toEqual({ allowed: false, reason: "hash_mismatch" });

    // 版本或权限不覆盖优先报 consent_missing。
    expect(
      resolvePluginContentTrust({
        packageHash: HASH_A,
        pluginId: "demo@inline",
        requiredPermissions: REQUIRED,
        requireHashBound: true,
        storageRoot: root,
        version: "2.0.0",
      }),
    ).toEqual({ allowed: false, reason: "consent_missing" });
    expect(
      resolvePluginContentTrust({
        packageHash: HASH_A,
        pluginId: "demo@inline",
        requiredPermissions: ["process", "code"],
        requireHashBound: true,
        storageRoot: root,
        version: "1.0.0",
      }),
    ).toEqual({ allowed: false, reason: "consent_missing" });
  });

  it("resolvePluginContentTrust backfills legacy consent before allowing", () => {
    const root = makeRoot("nibi-consent-resolve-backfill-");
    writePluginConsent({
      permissions: REQUIRED,
      pluginId: "demo@inline",
      storageRoot: root,
      version: "1.0.0",
    });
    expect(auditCount(root)).toBe(1);

    expect(
      resolvePluginContentTrust({
        packageHash: HASH_A,
        pluginId: "demo@inline",
        requiredPermissions: REQUIRED,
        requireHashBound: true,
        storageRoot: root,
        version: "1.0.0",
      }),
    ).toEqual({ allowed: true });

    expect(readPluginConsents(root).plugins["demo@inline"]?.packageHash).toBe(HASH_A);
    expect(auditCount(root)).toBe(1);
  });

  it("resolvePluginContentTrust reports hash_missing when legacy consent cannot be bound", () => {
    const root = makeRoot("nibi-consent-resolve-missing-");
    writePluginConsent({
      permissions: REQUIRED,
      pluginId: "demo@inline",
      storageRoot: root,
      version: "1.0.0",
    });

    // 调用方没有提供当前 hash。
    expect(
      resolvePluginContentTrust({
        pluginId: "demo@inline",
        requiredPermissions: REQUIRED,
        requireHashBound: true,
        storageRoot: root,
        version: "1.0.0",
      }),
    ).toEqual({ allowed: false, reason: "hash_missing" });

    // 提供了非法格式的 hash，无法补写。
    expect(
      resolvePluginContentTrust({
        packageHash: "sha256:nope",
        pluginId: "demo@inline",
        requiredPermissions: REQUIRED,
        requireHashBound: true,
        storageRoot: root,
        version: "1.0.0",
      }),
    ).toEqual({ allowed: false, reason: "hash_missing" });
  });

  it("resolvePluginContentTrust accepts an already bound record without a current hash", () => {
    const root = makeRoot("nibi-consent-resolve-bound-");
    writePluginConsent({
      packageHash: HASH_A,
      permissions: REQUIRED,
      pluginId: "demo@inline",
      storageRoot: root,
      version: "1.0.0",
    });

    expect(
      resolvePluginContentTrust({
        pluginId: "demo@inline",
        requiredPermissions: REQUIRED,
        requireHashBound: true,
        storageRoot: root,
        version: "1.0.0",
      }),
    ).toEqual({ allowed: true });
  });

  it("treats a same-version content swap as needing fresh consent", () => {
    const root = makeRoot("nibi-consent-swap-");
    writePluginConsent({
      packageHash: HASH_A,
      permissions: REQUIRED,
      pluginId: "demo@inline",
      storageRoot: root,
      version: "1.0.0",
    });

    const raw = readFileSync(join(root, PLUGIN_CONSENT_FILE), "utf8");
    expect(raw).toContain(HASH_A);
    expect(
      resolvePluginContentTrust({
        packageHash: HASH_B,
        pluginId: "demo@inline",
        requiredPermissions: REQUIRED,
        requireHashBound: true,
        storageRoot: root,
        version: "1.0.0",
      }).allowed,
    ).toBe(false);
  });
});
