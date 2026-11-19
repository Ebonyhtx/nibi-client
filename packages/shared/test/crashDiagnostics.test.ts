import { describe, expect, it } from "vitest";
import {
  classifyDiagnosticText,
  classifyExit,
  fingerprintCrash,
  parseStderrDiagnostics,
  sanitizeDiagnosticText,
  type DiagnosticJsonValue,
  type ExitInfo,
} from "@nibi/shared/crash-diagnostics";

describe("classifyExit", () => {
  it.each<[string, ExitInfo, ReturnType<typeof classifyExit>]>([
    ["bare zero exit", { exitCode: 0 }, "normal"],
    ["clean-exit reason", { exitCode: 0, reason: "clean-exit" }, "normal"],
    ["expected non-zero exit", { exitCode: 1, expected: true }, "normal"],
    ["unexpected zero exit", { exitCode: 0, expected: false }, "crash"],
    ["non-zero exit", { exitCode: 1 }, "crash"],
    ["segfault signal", { signal: "SIGSEGV" }, "crash"],
    ["oom reason", { reason: "oom", exitCode: 137 }, "oom"],
    ["memory eviction", { reason: "memory-eviction" }, "oom"],
    [
      "oom diagnostic text",
      { exitCode: 137, diagnosticText: "FATAL ERROR: JavaScript heap out of memory" },
      "oom",
    ],
    [
      "oom diagnostic code",
      { exitCode: 1, diagnostics: [{ class: "generic", code: "ERR_OUT_OF_MEMORY" }] },
      "oom",
    ],
    ["crashed reason", { reason: "crashed", exitCode: 0 }, "crash"],
    [
      "protocol close outranks cleanup SIGTERM",
      { reason: "protocol-close", signal: "SIGTERM" },
      "crash",
    ],
    ["SIGTERM", { signal: "SIGTERM" }, "killed"],
    ["SIGKILL", { signal: "SIGKILL" }, "killed"],
    ["killed reason", { reason: "killed", exitCode: 1 }, "killed"],
    ["Windows controlled exit", { exitCode: 0x40010004 }, "killed"],
    [
      "startup failure before ready",
      { exitCode: 1, runtimeReady: false },
      "startupFailure",
    ],
    ["launch failure reason", { exitCode: 1, reason: "launch-failed" }, "startupFailure"],
    ["tool failure reason", { exitCode: 1, reason: "tool-failure" }, "toolFailure"],
    [
      "tool failure code",
      { exitCode: 1, diagnostics: [{ class: "generic", code: "ERR_TOOL_TIMEOUT" }] },
      "toolFailure",
    ],
    ["no facts", {}, "unknown"],
    ["null facts", { exitCode: null, signal: null }, "unknown"],
  ])("classifies %s", (_name, info, expected) => {
    expect(classifyExit(info)).toBe(expected);
  });

  it("keeps OOM evidence above expected/killed flags", () => {
    expect(
      classifyExit({
        expected: true,
        signal: "SIGTERM",
        diagnosticText: "JavaScript heap out of memory",
      }),
    ).toBe("oom");
  });
});

describe("fingerprintCrash", () => {
  it("is stable across pids, timestamps, paths, user names, UUIDs and stack locations", () => {
    const first = fingerprintCrash({
      name: "Error",
      code: "EPIPE",
      message:
        "write EPIPE pid=111 node:222 user=alice alice@corp.example.com at 2026-11-19T10:00:00.000Z ts=1763553600000 /Users/alice/project/child.js id=1f51b7dc-c52a-46ad-bc97-d2f984e6e3de",
      stack: "    at Socket._write (/Users/alice/project/child.js:10:20)",
      pid: 111,
      timestamp: 1_700_000_000_000,
    });
    const second = fingerprintCrash({
      name: "Error",
      code: "EPIPE",
      message:
        "write EPIPE pid=987 node:654 user=bob bob@corp.example.com at 2026-12-31T23:59:59.999Z ts=1763553700000 /home/bob/project/child.js id=2f51b7dc-c52a-46ad-bc97-d2f984e6e3de",
      stack: "    at Socket._write (/home/bob/project/child.js:99:88)",
      pid: 987,
      timestamp: 1_800_000_000_000,
    });

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{16}$/);
  });

  it("changes when the cause changes", () => {
    const epipe = fingerprintCrash({
      name: "Error",
      code: "EPIPE",
      message: "write EPIPE",
      stack: "at write",
    });
    const reset = fingerprintCrash({
      name: "Error",
      code: "ECONNRESET",
      message: "read ECONNRESET",
      stack: "at write",
    });
    expect(epipe).not.toBe(reset);
  });

  it("keeps explicit parts byte-compatible with the legacy four-part call", () => {
    expect(
      fingerprintCrash({
        parts: ["Error", "EPIPE", "write EPIPE token=<redacted>", "at run (<workspace>/a.js:<line>:<column>)"],
      }),
    ).toBe("089abdf382bd9e24");
  });
});

describe("sanitizeDiagnosticText", () => {
  it("redacts workspace, home directories, absolute paths and tokens", () => {
    const workspacePath = "/Users/alice/private-project";
    const value = [
      `Error: write EPIPE token=super-secret at ${workspacePath}`,
      "    at Socket._write (/Users/bob/.nibi/state.db:10:20)",
      "    at load (/opt/example/tool.js:50:60)",
      "request URL contains sk-1234567890abcdefghijklmnopqrstuv",
    ].join("\n");

    const sanitized = sanitizeDiagnosticText(value, { workspacePath });

    expect(sanitized).toContain("<workspace>");
    expect(sanitized).toContain("<home>/.nibi/state.db");
    expect(sanitized).toContain("<path>");
    expect(sanitized).toContain("token=<redacted>");
    expect(sanitized).toContain("sk-<redacted>");
    expect(sanitized).not.toContain("super-secret");
    expect(sanitized).not.toContain("alice");
    expect(sanitized).not.toContain("bob");
    expect(sanitized).not.toContain("/opt/example");
    expect(sanitized).not.toContain("sk-1234567890abcdefghijklmnopqrstuv");
  });

  it("redacts URL credentials and Authorization tokens", () => {
    const sanitized = sanitizeDiagnosticText(
      "fetch https://alice:supersecret@example.com/path; header Bearer abc.def.ghi",
    );

    expect(sanitized).toContain("https://<redacted>@example.com");
    expect(sanitized).toContain("Bearer <redacted>");
    expect(sanitized).not.toContain("alice");
    expect(sanitized).not.toContain("supersecret");
    expect(sanitized).not.toContain("abc.def.ghi");

    const authorization = sanitizeDiagnosticText("Authorization: Bearer abc.def.ghi");
    expect(authorization).toBe("Authorization: Bearer <redacted>");
  });

  it("bounds strings and structured values by maxLength and maxDepth", () => {
    expect(sanitizeDiagnosticText("x".repeat(20), { maxLength: 4 })).toBe("xxxx");

    const value: DiagnosticJsonValue = {
      token: "secret=abc",
      nested: { deeper: { deepest: "token=abc" } },
      list: ["/Users/alice/file.ts"],
    };
    const sanitized = sanitizeDiagnosticText(value, { maxDepth: 2 }) as {
      token: string;
      nested: { deeper: DiagnosticJsonValue };
      list: string[];
    };

    expect(sanitized.token).toBe("secret=<redacted>");
    expect(sanitized.nested.deeper).toBe("<depth-limit>");
    expect(sanitized.list[0]).toBe("<home>/file.ts");
  });
});

describe("parseStderrDiagnostics", () => {
  it("selects the OOM line over GC/native noise", () => {
    const parsed = parseStderrDiagnostics([
      "<--- Last few GCs --->",
      "[189964:0x18a8001c8000] Mark-Compact 3691 MB",
      "FATAL ERROR: CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory",
      "----- Native stack trace -----",
      " 1: 0x00007ff6deadbeef",
    ]);

    expect(parsed.primary).toMatchObject({
      class: "oom",
      name: "AgentOutOfMemory",
      code: "ERR_OUT_OF_MEMORY",
      message: "CALL_AND_RETRY_LAST Allocation failed - JavaScript heap out of memory",
    });
    expect(parsed.errorName).toBe("AgentOutOfMemory");
    expect(parsed.errorCode).toBe("ERR_OUT_OF_MEMORY");
    expect(parsed.diagnosticClass).toBe("oom");
  });

  it("selects SQLite diagnostics and keeps a typed class", () => {
    const parsed = parseStderrDiagnostics([
      "ExperimentalWarning: SQLite is an experimental feature",
      "Error: SQLite migration initialization failed for C:\\Users\\alice\\.nibi\\cli\\db\\db.sqlite",
    ]);

    expect(parsed.primary).toMatchObject({
      class: "sqlite",
      name: "Error",
      code: "",
    });
    expect(parsed.primary?.message).toContain("SQLite migration initialization failed");
    expect(parsed.diagnosticClass).toBe("sqlite");
  });

  it("selects errno diagnostics after removing structural noise", () => {
    const parsed = parseStderrDiagnostics([
      "[Object]",
      "node:events:486",
      "EPERM: process.cwd failed with error operation not permitted, uv_cwd",
      "1: 0x00007ff6deadbeef",
    ]);

    expect(parsed.primary).toMatchObject({
      class: "errno",
      name: "AgentProcessExit",
      code: "EPERM",
      message: "EPERM: process.cwd failed with error operation not permitted, uv_cwd",
    });
    expect(parsed.errorName).toBe("AgentProcessExit");
    expect(parsed.errorCode).toBe("EPERM");
    expect(parsed.diagnosticClass).toBe("errno");
  });

  it("returns none for noise-only stderr", () => {
    const parsed = parseStderrDiagnostics([
      "[Object], [Object], [Object],",
      "<--- Last few GCs --->",
      "----- Native stack trace -----",
      "1: 0x00007ff6deadbeef",
      "(node:1234) ExperimentalWarning: SQLite is an experimental feature and might change at any time",
      "(Use `Nibi --trace-warnings ...` to show where the warning was created)",
      "},",
    ]);

    expect(parsed.primary).toBeNull();
    expect(parsed.errorName).toBe("AgentProcessExit");
    expect(parsed.errorMessage).toBeNull();
    expect(parsed.diagnosticClass).toBe("none");
  });

  it("deduplicates identical causes across pids, user names and stack locations", () => {
    const parsed = parseStderrDiagnostics([
      "Error: write EPIPE pid=111 at /Users/alice/app.js:10:20",
      "Error: write EPIPE pid=222 at /home/bob/app.js:99:88",
    ]);

    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0]).toMatchObject({
      class: "errno",
      code: "EPIPE",
      lineNumber: 1,
      occurrences: 2,
    });
  });

  it("bounds diagnostic count and text length", () => {
    const lines = Array.from({ length: 50 }, (_, index) => `Error: ${index} ${"x".repeat(80)}`);
    const parsed = parseStderrDiagnostics(lines, {
      maxDiagnostics: 5,
      maxLineLength: 20,
      maxMessageLength: 10,
    });

    expect(parsed.diagnostics).toHaveLength(5);
    expect(parsed.truncated).toBe(true);
    expect(parsed.lineCount).toBe(50);
    for (const diagnostic of parsed.diagnostics) {
      expect(diagnostic.line.length).toBeLessThanOrEqual(20);
      expect(diagnostic.message.length).toBeLessThanOrEqual(10);
    }
  });

  it("supports a zero diagnostic bound and records the first stack frame", () => {
    const parsed = parseStderrDiagnostics(
      ["Error: boom", "    at run (C:\\repo\\cli.js:1:2)"],
      { maxDiagnostics: 0 },
    );

    expect(parsed.diagnostics).toEqual([]);
    expect(parsed.primary).toBeNull();
    expect(parsed.truncated).toBe(true);
    expect(parsed.firstStackFrame).toBe("at run (C:\\repo\\cli.js:1:2)");
  });

  it("normalizes backslashes in the summary but not the raw stack frame", () => {
    const parsed = parseStderrDiagnostics("Error: failed at C:\\repo\\cli.js");

    expect(parsed.primary?.message).toBe("failed at C:/repo/cli.js");
    expect(parsed.errorMessage).toBe("failed at C:/repo/cli.js");
  });
});

describe("classifyDiagnosticText", () => {
  it("keeps the legacy diagnostic_class precedence", () => {
    expect(classifyDiagnosticText("JavaScript heap out of memory", "", true)).toBe("oom");
    expect(classifyDiagnosticText("SQLite migration failed", "", true)).toBe("sqlite");
    expect(classifyDiagnosticText("boom", "EPIPE", true)).toBe("errno");
    expect(classifyDiagnosticText("boom", "", true)).toBe("generic");
    expect(classifyDiagnosticText("boom", "", false)).toBe("none");
  });
});
