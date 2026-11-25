import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PLUGIN_AUDIT_FILE,
  appendPluginAuditEvent,
  prunePluginAuditEvents,
  readRecentPluginAuditEvents,
  resetPluginAuditPruneThrottleForTests,
} from "../src/plugins/helpers.js";

const roots: string[] = [];

function makeRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function writeAudit(root: string, lines: readonly string[]): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, PLUGIN_AUDIT_FILE),
    lines.length > 0 ? `${lines.join("\n")}\n` : "",
    "utf8",
  );
}

function auditLine(at: string, pluginId: string, type = "consent_granted"): string {
  return JSON.stringify({ at, pluginId, type });
}

beforeEach(() => {
  resetPluginAuditPruneThrottleForTests();
});

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { force: true, recursive: true });
});

describe("plugin audit retention", () => {
  it("skips bad lines and returns newest events first", () => {
    const root = makeRoot("nibi-audit-read-");
    writeAudit(root, [
      auditLine("2026-11-01T00:00:00.000Z", "oldest"),
      "{ not json",
      auditLine("2026-11-20T00:00:00.000Z", "same-time-first"),
      auditLine("2026-11-20T00:00:00.000Z", "same-time-second", "consent_revoked"),
      JSON.stringify({ at: "2026-11-22T00:00:00.000Z" }),
      auditLine("not-a-date", "bad-date"),
      auditLine("2026-11-24T00:00:00.000Z", "newest", "grants_updated"),
    ]);

    const events = readRecentPluginAuditEvents(root);
    expect(events.map((event) => event.pluginId)).toEqual([
      "newest",
      "same-time-second",
      "same-time-first",
      "oldest",
    ]);
    // 同一时间按行序倒排：后写入的在前。
    expect(events[1]?.type).toBe("consent_revoked");
  });

  it("honours the limit, including the default of 10", () => {
    const root = makeRoot("nibi-audit-limit-");
    const lines = Array.from({ length: 12 }, (_, index) =>
      auditLine(
        `2026-11-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
        `plugin-${index}`,
      ),
    );
    writeAudit(root, lines);

    const limited = readRecentPluginAuditEvents(root, 2);
    expect(limited.map((event) => event.pluginId)).toEqual(["plugin-11", "plugin-10"]);

    expect(readRecentPluginAuditEvents(root)).toHaveLength(10);
    expect(readRecentPluginAuditEvents(root, 0)).toEqual([]);
  });

  it("returns an empty list for a missing audit file", () => {
    const root = makeRoot("nibi-audit-missing-");
    expect(readRecentPluginAuditEvents(root)).toEqual([]);
    expect(prunePluginAuditEvents(root)).toBe(0);
  });

  it("prunes entries older than 30 days and removes bad lines", () => {
    const root = makeRoot("nibi-audit-prune-");
    writeAudit(root, [
      auditLine("2026-10-31T00:00:00.000Z", "expired"),
      auditLine("2026-11-15T00:00:00.000Z", "kept"),
      "{ broken",
      auditLine("2026-11-30T00:00:00.000Z", "future"),
    ]);

    const deleted = prunePluginAuditEvents(root, {
      now: new Date("2026-12-01T00:00:00.000Z"),
    });
    expect(deleted).toBe(2);

    expect(readRecentPluginAuditEvents(root, 10).map((event) => event.pluginId)).toEqual(
      expect.arrayContaining(["kept", "future"]),
    );
    const raw = readFileSync(join(root, PLUGIN_AUDIT_FILE), "utf8");
    expect(raw).not.toContain("expired");
    expect(raw).not.toContain("broken");
  });

  it("supports a custom retention window and keeps the exact cutoff", () => {
    const root = makeRoot("nibi-audit-retention-");
    writeAudit(root, [
      auditLine("2026-11-18T23:59:59.999Z", "expired"),
      auditLine("2026-11-19T00:00:00.000Z", "cutoff"),
      auditLine("2026-11-19T12:00:00.000Z", "fresh"),
    ]);

    const deleted = prunePluginAuditEvents(root, {
      now: new Date("2026-11-20T00:00:00.000Z"),
      retentionDays: 1,
    });
    expect(deleted).toBe(1);
    expect(readRecentPluginAuditEvents(root, 10).map((event) => event.pluginId)).toEqual([
      "fresh",
      "cutoff",
    ]);
  });

  it("does not rewrite the file when nothing is prunable", () => {
    const root = makeRoot("nibi-audit-noop-");
    writeAudit(root, [auditLine("2026-11-25T00:00:00.000Z", "fresh")]);
    const target = join(root, PLUGIN_AUDIT_FILE);
    const before = readFileSync(target, "utf8");

    expect(prunePluginAuditEvents(root, { now: new Date("2026-11-26T00:00:00.000Z") })).toBe(0);
    expect(readFileSync(target, "utf8")).toBe(before);
  });

  it("appends and throttles pruning without blocking writes", () => {
    const root = makeRoot("nibi-audit-throttle-");
    const at = "2026-11-25T00:00:00.000Z";
    appendPluginAuditEvent(root, { at, pluginId: "first", type: "consent_granted" });
    expect(existsSync(join(root, PLUGIN_AUDIT_FILE))).toBe(true);

    // 手动塞一条过期行：6 小时节流内 append 不应清理它。
    appendFileSync(
      join(root, PLUGIN_AUDIT_FILE),
      `${auditLine("2000-01-01T00:00:00.000Z", "expired")}\n`,
      "utf8",
    );
    expect(() =>
      appendPluginAuditEvent(root, { at, pluginId: "second", type: "consent_granted" }),
    ).not.toThrow();
    expect(readFileSync(join(root, PLUGIN_AUDIT_FILE), "utf8")).toContain("expired");

    // 重置节流后，下一次 append 触发 prune。
    resetPluginAuditPruneThrottleForTests();
    appendPluginAuditEvent(root, { at, pluginId: "third", type: "consent_granted" });
    const raw = readFileSync(join(root, PLUGIN_AUDIT_FILE), "utf8");
    expect(raw).not.toContain("expired");
    expect(
      readRecentPluginAuditEvents(root, 10).map((event) => event.pluginId),
    ).toEqual(["third", "second", "first"]);
  });

  it("never throws when the audit path is unwritable", () => {
    const root = makeRoot("nibi-audit-unwritable-");
    const notADirectory = join(root, "file-as-storage");
    writeFileSync(notADirectory, "not a directory", "utf8");

    expect(() =>
      appendPluginAuditEvent(notADirectory, {
        at: "2026-11-25T00:00:00.000Z",
        pluginId: "demo",
        type: "consent_granted",
      }),
    ).not.toThrow();
  });
});
