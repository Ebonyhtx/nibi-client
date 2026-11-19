// 跨来源与归档目标策略：来源不匹配必须在访问 owner 之前拒绝；归档目标只拒绝显式打开与
// fork（上游导航把归档目标视为不在当前投影内），不能阻塞读取、发送、等待或组织写入。
import { describe, expect, it } from "vitest";
import { createAppSessionControl } from "#session-control/application/app/index";
import { createCliSessionControl } from "#session-control/application/cli/index";
import { createTestPorts } from "#session-control/testing/index";
import {
  SessionControlError,
  type AppSessionRef,
  type AppSessionTrustedContext,
  type CliSessionRef,
} from "#session-control/contract";

const appRoot: AppSessionRef = {
  kind: "app",
  workspacePath: "/workspace",
  sourceServerId: "source-a",
  sessionId: "sess_root",
};
const appTarget: AppSessionRef = { ...appRoot, sessionId: "sess_target" };
const foreignTarget: AppSessionRef = { ...appTarget, sourceServerId: "source-b" };
const cliRoot: CliSessionRef = {
  kind: "cli",
  workspacePath: "/workspace",
  sessionId: "sess_root",
};
const cliTarget: CliSessionRef = { ...cliRoot, sessionId: "sess_target" };

function appFixture() {
  const ports = createTestPorts("app", appRoot);
  return { ports, ctx: ports.context, control: createAppSessionControl(ports.app) };
}
function cliFixture() {
  const ports = createTestPorts("cli", cliRoot);
  return { ports, ctx: ports.context, control: createCliSessionControl(ports.cli) };
}
/** 保留 testing 端口的记录，再返回测试要求的归档事实。 */
function archivedAppPorts(ports: ReturnType<typeof appFixture>["ports"], value: boolean | undefined) {
  const record = ports.app.sessions.isSessionArchived!;
  ports.app.sessions.isSessionArchived = async (ctx, session) => {
    await record(ctx, session);
    return value;
  };
}
function archivedCliPorts(ports: ReturnType<typeof cliFixture>["ports"], value: boolean | undefined) {
  const record = ports.cli.sessions.isSessionArchived!;
  ports.cli.sessions.isSessionArchived = async (ctx, session) => {
    await record(ctx, session);
    return value;
  };
}

type AppControl = ReturnType<typeof createAppSessionControl>;
type AppContext = AppSessionTrustedContext;

const crossSourceActions: Array<[string, (control: AppControl, ctx: AppContext) => Promise<unknown>]> =
  [
    [
      "setSessionArchived",
      (control, ctx) =>
        control.setSessionArchived(ctx, {
          session: foreignTarget,
          archived: true,
          requestId: "r",
        }),
    ],
    [
      "setSessionPinned",
      (control, ctx) =>
        control.setSessionPinned(ctx, { session: foreignTarget, pinned: true, requestId: "r" }),
    ],
    ["openSession", (control, ctx) => control.openSession(ctx, { session: foreignTarget })],
    [
      "forkSession",
      (control, ctx) =>
        control.forkSession(ctx, { session: foreignTarget, atMessage: "msg_1", requestId: "r" }),
    ],
    [
      "sendToSession",
      (control, ctx) =>
        control.sendToSession(ctx, { session: foreignTarget, prompt: "go", requestId: "r" }),
    ],
    [
      "readSession",
      (control, ctx) => control.readSession(ctx, { session: foreignTarget, view: "summary" }),
    ],
    [
      "interruptSession",
      (control, ctx) =>
        control.interruptSession(ctx, {
          session: foreignTarget,
          expectedExecutionId: "exec_1",
          requestId: "r",
        }),
    ],
    [
      "renameSession",
      (control, ctx) =>
        control.renameSession(ctx, { session: foreignTarget, title: "x", requestId: "r" }),
    ],
    [
      "waitSessions",
      (control, ctx) =>
        control.waitSessions(ctx, {
          operations: [
            { session: foreignTarget, sessionId: foreignTarget.sessionId, commandId: "c" },
          ],
          mode: "any",
          timeoutMs: 0,
        }),
    ],
  ];

describe("cross-source targets", () => {
  it("rejects a target from another source before any owner call", async () => {
    for (const [name, run] of crossSourceActions) {
      const { control, ctx, ports } = appFixture();
      await expect(run(control, ctx), name).rejects.toMatchObject({ code: "forbidden" });
      // 与目标不存在同一错误；连归档事实都没有读取，不能借此探测其他来源的会话。
      expect(ports.calls, name).toEqual([]);
    }
  });

  it("CLI fork/send/wait reject another workspace before any owner call", async () => {
    const { control, ctx, ports } = cliFixture();
    const other = { ...cliTarget, workspacePath: "/other" };
    await expect(
      control.forkSession(ctx, { session: other, atMessage: "msg_1", requestId: "r1" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      control.sendToSession(ctx, { session: other, prompt: "go", requestId: "r2" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      control.waitSessions(ctx, {
        operations: [{ session: other, sessionId: other.sessionId, commandId: "c" }],
        mode: "any",
        timeoutMs: 0,
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(ports.calls).toEqual([]);
  });
});

describe("archived targets", () => {
  it("OpenSession returns the upstream unavailable result and does not navigate", async () => {
    const { control, ctx, ports } = appFixture();
    archivedAppPorts(ports, true);
    await expect(control.openSession(ctx, { session: appTarget })).resolves.toEqual({
      status: "unavailable",
      reason: "project.task-not-found",
    });
    expect(ports.calls.map((call) => call.method)).toEqual(["authorize", "isSessionArchived"]);
  });

  it("OpenSession proceeds when the owner does not report archive state", async () => {
    const { control, ctx, ports } = appFixture();
    archivedAppPorts(ports, undefined);
    await expect(control.openSession(ctx, { session: appTarget })).resolves.toMatchObject({
      status: "opened",
    });
    expect(ports.calls.map((call) => call.method)).toEqual([
      "authorize",
      "isSessionArchived",
      "openSession",
    ]);
  });

  it("ForkSession fails before creating a child session", async () => {
    const { control, ctx, ports } = appFixture();
    archivedAppPorts(ports, true);
    await expect(
      control.forkSession(ctx, { session: appTarget, atMessage: "msg_1", requestId: "r" }),
    ).rejects.toMatchObject({ code: "unavailable", message: "Target session is archived" });
    expect(ports.calls.map((call) => call.method)).toEqual(["authorize", "isSessionArchived"]);
    expect(ports.calls.some((call) => call.method === "forkSession")).toBe(false);
  });

  it("ForkSession fails closed when archive state cannot be confirmed", async () => {
    const { control, ctx, ports } = appFixture();
    ports.app.sessions.isSessionArchived = async () => {
      throw new SessionControlError("unavailable", "Session archive state is unavailable");
    };
    await expect(
      control.forkSession(ctx, { session: appTarget, atMessage: "msg_1", requestId: "r" }),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(ports.calls.some((call) => call.method === "forkSession")).toBe(false);
  });

  it("archive is organizational: read, send and wait stay available", async () => {
    const { control, ctx, ports } = appFixture();
    ports.app.sessions.isSessionArchived = async () => true;
    await expect(control.readSession(ctx, { session: appTarget, view: "summary" })).resolves.toMatchObject({
      view: "summary",
    });
    await expect(
      control.sendToSession(ctx, { session: appTarget, prompt: "go", requestId: "r" }),
    ).resolves.toMatchObject({ admission: "accepted" });
    await expect(
      control.setSessionArchived(ctx, {
        session: appTarget,
        archived: false,
        requestId: "unarchive",
      }),
    ).resolves.toMatchObject({ status: "applied" });
    await expect(
      control.waitSessions(ctx, {
        operations: [{ session: appTarget, sessionId: appTarget.sessionId, commandId: "c" }],
        mode: "any",
        timeoutMs: 0,
      }),
    ).resolves.toBeDefined();
  });

  it("CLI ForkSession fails before creating a child session", async () => {
    const { control, ctx, ports } = cliFixture();
    archivedCliPorts(ports, true);
    await expect(
      control.forkSession(ctx, { session: cliTarget, atMessage: "msg_1", requestId: "r" }),
    ).rejects.toMatchObject({ code: "unavailable", message: "Target session is archived" });
    expect(ports.calls.map((call) => call.method)).toEqual(["authorize", "isSessionArchived"]);
  });

  it("CLI send still reaches an archived target", async () => {
    const { control, ctx, ports } = cliFixture();
    archivedCliPorts(ports, true);
    await expect(
      control.sendToSession(ctx, { session: cliTarget, prompt: "go", requestId: "r" }),
    ).resolves.toMatchObject({ admission: "accepted" });
  });
});