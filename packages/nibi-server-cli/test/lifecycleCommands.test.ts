import { spawn } from "node:child_process";
import { link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NIBI_VERSION } from "@nibi/shared";
import { runServerCli } from "../src/cli.js";
import { serverStatusSchema, type ServerStatus } from "../src/contracts.js";
import { isControlEndpointUnavailable, requestControl } from "../src/ipc/controlClient.js";
import { createControlServer } from "../src/ipc/controlServer.js";
import { DataRootLock } from "../src/runtime/lock.js";
import { resolveServerLayout, type ServerLayout } from "../src/runtime/paths.js";
import { ReleaseManager } from "../src/runtime/releaseManager.js";
import { stopSupervisorAndWait, waitForServerStopped } from "../src/runtime/shutdownWait.js";

function status(state: ServerStatus["state"], overrides: Partial<ServerStatus> = {}): ServerStatus {
  return serverStatusSchema.parse({
    protocolVersion: 1,
    state,
    pid: state === "ready" ? 4242 : null,
    port: state === "ready" ? 43123 : null,
    host: state === "ready" ? "127.0.0.1" : null,
    version: NIBI_VERSION,
    generation: state === "ready" ? 1 : 0,
    startedAt: state === "ready" ? 1 : null,
    lastExitReason: null,
    serviceRegistered: false,
    runningTaskCount: 0,
    crashBudget: { crashCount: 0, nextRestartDelayMs: 1_000, exhausted: false },
    updatedAt: Date.now(),
    ...overrides,
  });
}

async function writeStatus(layout: ServerLayout, value: ServerStatus): Promise<void> {
  await mkdir(layout.runDir, { recursive: true });
  await writeFile(layout.statusFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createRoot(prefix: string): Promise<{
  root: string;
  serverRoot: string;
  layout: ServerLayout;
}> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const serverRoot = join(root, "server");
  const layout = resolveServerLayout(serverRoot);
  await mkdir(layout.runDir, { recursive: true });
  return { root, serverRoot, layout };
}

async function prepareFakeRelease(layout: ServerLayout): Promise<void> {
  const releases = new ReleaseManager(layout);
  await releases.ensure();
  const releaseDir = join(layout.releasesDir, "release-crash-recovery");
  const runtimeRoot = join(releaseDir, "runtime");
  await mkdir(runtimeRoot, { recursive: true });
  const nodeBinary = join(runtimeRoot, process.platform === "win32" ? "node.exe" : "node");
  try {
    // hardlink 与 symlink 都只借用当前 Node，不在临时目录复制整套运行时。
    await (process.platform === "win32"
      ? link(process.execPath, nodeBinary)
      : symlink(process.execPath, nodeBinary));
  } catch {
    const { copyFile } = await import("node:fs/promises");
    await copyFile(process.execPath, nodeBinary);
  }
  await writeFile(
    join(runtimeRoot, "server-core.js"),
    [
      "const generation = Number(process.argv[2] ?? 0);",
      "process.send({ type: 'ready', host: '127.0.0.1', port: 43123, version: process.env.NIBI_TEST_CORE_VERSION ?? 'test', generation });",
      "process.on('message', (message) => {",
      "  if (message && message.command === 'shutdown') {",
      "    try { process.send({ type: 'shutdown-ack' }); } catch {}",
      "    process.exit(0);",
      "  }",
      "});",
      "setInterval(() => {}, 1_000);",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(join(runtimeRoot, "package.json"), '{"type":"module"}\n', "utf8");
  await releases.writePending({
    version: NIBI_VERSION,
    releaseDir,
    releaseId: "release-crash-recovery",
  });
  await releases.applyPending();
}

function spawnCli(serverRoot: string, args: readonly string[]) {
  const mainEntry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const child = spawn(
    process.execPath,
    ["--import", "tsx", mainEntry, ...args, "--server-root", serverRoot],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, "--import", "tsx"].filter(Boolean).join(" "),
        NIBI_SERVER_SKIP_SERVICE_REGISTRATION: "1",
        NIBI_TEST_CORE_VERSION: NIBI_VERSION,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let output = "";
  let errors = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    errors += String(chunk);
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  return {
    child,
    diagnostics: () => `${output}\n${errors}`,
    lastJson: () => JSON.parse(output.trim().split("\n").at(-1) ?? "{}"),
    wait: async (timeoutMs: number): Promise<number | null | "timeout"> => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          exited,
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    cleanup: async (root?: string, layout?: ServerLayout): Promise<void> => {
      if (layout) {
        await requestControl(layout.controlEndpoint, { command: "stop" }).catch(() => undefined);
        await waitForServerStopped(layout).catch(() => undefined);
      }
      if (child.exitCode === null) child.kill("SIGKILL");
      await exited.catch(() => undefined);
      if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function waitForControlState(layout: ServerLayout, expected: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const status = (await requestControl(layout.controlEndpoint, { command: "status" }, 250)) as {
        state?: string;
      };
      if (status.state === expected) return;
    } catch {
      // Supervisor/Core 仍在启动，继续轮询。
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for control state ${expected}`);
}

function cliDiagnostics(output: string[], errors: string[]): string {
  return `${output.join("")}
${errors.join("")}`;
}

function createIo(): {
  output: string[];
  errors: string[];
  io: Parameters<typeof runServerCli>[1];
} {
  const output: string[] = [];
  const errors: string[] = [];
  return {
    output,
    errors,
    io: {
      stdout: { write: (value) => output.push(value) },
      stderr: { write: (value) => errors.push(value) },
    },
  };
}

describe("Server CLI stop --wait", () => {
  it("waits for the lock release and a fresh stopped snapshot before returning", async () => {
    const { serverRoot, layout } = await createRoot("nibi-cli-stop-wait-");
    const lock = new DataRootLock(layout.lockFile);
    await lock.acquire();
    await writeStatus(layout, status("ready", { updatedAt: Date.now() - 5_000 }));
    const control = await createControlServer(layout.controlEndpoint, async (request) => {
      if (request.command !== "stop") throw new Error(`unexpected ${request.command}`);
      // 模拟 Supervisor：先 ack，再落盘 stopped、释放锁。stop --wait 只能在后者完成后返回。
      setTimeout(() => {
        void writeStatus(layout, status("stopped", { updatedAt: Date.now() + 1_000 })).then(() =>
          lock.release(),
        );
      }, 300);
      return { stopping: true };
    });
    const { output, errors, io } = createIo();
    const startedAt = Date.now();
    try {
      const exit = await runServerCli(
        ["stop", "--wait", "--json", "--server-root", serverRoot],
        io,
      );
      const elapsed = Date.now() - startedAt;
      expect(exit, cliDiagnostics(output, errors)).toBe(0);
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({ state: "stopped" });
    } finally {
      await control.close();
      await lock.release().catch(() => undefined);
    }
  });

  it("returns immediately with a stopped status when no daemon is running", async () => {
    const { serverRoot, layout } = await createRoot("nibi-cli-stop-idle-");
    // 残留的 ready 快照不能代表仍有 Supervisor；锁缺失或 stale 即视为已停止。
    await writeStatus(layout, status("ready", { updatedAt: Date.now() - 5_000 }));
    const { output, io } = createIo();
    const startedAt = Date.now();
    const exit = await runServerCli(["stop", "--wait", "--json", "--server-root", serverRoot], io);
    expect(exit).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(JSON.parse(output.at(-1) ?? "{}")).toMatchObject({ state: "stopped" });
  });

  it("fails with the public stop-failed code instead of waiting for a timeout", async () => {
    const { serverRoot, layout } = await createRoot("nibi-cli-stop-failed-");
    const lock = new DataRootLock(layout.lockFile);
    await lock.acquire();
    await writeStatus(layout, status("ready", { updatedAt: Date.now() - 5_000 }));
    const control = await createControlServer(layout.controlEndpoint, async (request) => {
      if (request.command !== "stop") throw new Error(`unexpected ${request.command}`);
      await writeStatus(
        layout,
        status("stop-failed", {
          updatedAt: Date.now() + 1_000,
          lastExitReason: "core did not terminate",
        }),
      );
      return { stopping: true };
    });
    const { output, errors, io } = createIo();
    try {
      const exit = await runServerCli(
        ["stop", "--wait", "--json", "--server-root", serverRoot],
        io,
      );
      expect(exit, cliDiagnostics(output, errors)).toBe(1);
      expect(JSON.parse(output.at(-1) ?? "{}"), cliDiagnostics(output, errors)).toMatchObject({
        ok: false,
        code: "source-server-stop-failed",
      });
    } finally {
      await control.close();
      await lock.release().catch(() => undefined);
    }
  });

  it("times out when the lock is still held after the stop window", async () => {
    const { layout } = await createRoot("nibi-cli-stop-timeout-");
    const lock = new DataRootLock(layout.lockFile);
    await lock.acquire();
    await writeStatus(layout, status("stopping", { updatedAt: Date.now() }));
    try {
      await expect(waitForServerStopped(layout, 0, true, 150)).rejects.toThrow(
        /Timed out waiting for Server shutdown/,
      );
    } finally {
      await lock.release();
    }
  });

  it("marks a control request that never answers as the public unresponsive code", async () => {
    const { layout } = await createRoot("nibi-cli-control-timeout-");
    // 接受连接但不应答：只验证超时码，不等待生产默认的超时窗口。
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(layout.controlEndpoint, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    try {
      await expect(
        requestControl(layout.controlEndpoint, { command: "status" }, 100),
      ).rejects.toMatchObject({ code: "source-server-control-unresponsive" });
      await expect(
        requestControl(layout.controlEndpoint, { command: "status" }, 100),
      ).rejects.toSatisfy((error: unknown) => !isControlEndpointUnavailable(error));
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("Server CLI restart", () => {
  it("recovers a daemon whose persisted state is crash-loop-stopped", async () => {
    const { root, serverRoot, layout } = await createRoot("nibi-cli-restart-crash-");
    await prepareFakeRelease(layout);
    await writeStatus(
      layout,
      status("crash-loop-stopped", {
        updatedAt: Date.now() - 10_000,
        lastExitReason: "core exited code=1 signal=none",
        crashBudget: {
          crashCount: 5,
          nextRestartDelayMs: 16_000,
          exhausted: true,
        },
      }),
    );

    // 没有存活的 Supervisor：残留状态和 control socket 都必须被新的 Supervisor 接管。
    const cli = spawnCli(serverRoot, ["restart", "--json"]);
    const exit = await cli.wait(20_000);
    try {
      expect(exit, cli.diagnostics()).not.toBe("timeout");
      expect(exit, cli.diagnostics()).toBe(0);
      expect(cli.lastJson()).toMatchObject({
        state: "ready",
        crashBudget: { crashCount: 0, exhausted: false },
      });
    } finally {
      await cli.cleanup(root, layout);
    }
  });

  it("restarts the running Supervisor and Core as a new process tree", async () => {
    const { root, serverRoot, layout } = await createRoot("nibi-cli-restart-running-");
    await prepareFakeRelease(layout);
    const supervisor = spawnCli(serverRoot, ["serve", "--supervisor", "--json"]);
    try {
      await waitForControlState(layout, "ready");
      const before = JSON.parse(await readFile(layout.lockFile, "utf8")) as { pid: number };
      const beforeCorePid = (
        (await requestControl(layout.controlEndpoint, { command: "status" })) as {
          pid: number;
        }
      ).pid;

      const restart = spawnCli(serverRoot, ["restart", "--json"]);
      const exit = await restart.wait(20_000);
      expect(exit, restart.diagnostics()).not.toBe("timeout");
      expect(exit, restart.diagnostics()).toBe(0);
      expect(restart.lastJson()).toMatchObject({ state: "ready" });

      const after = JSON.parse(await readFile(layout.lockFile, "utf8")) as { pid: number };
      const afterCorePid = (
        (await requestControl(layout.controlEndpoint, { command: "status" })) as {
          pid: number;
        }
      ).pid;
      expect(after.pid).not.toBe(before.pid);
      expect(afterCorePid).not.toBe(beforeCorePid);
      await restart.cleanup();
    } finally {
      await supervisor.cleanup(root, layout);
    }
    // 真正拉起 Supervisor + Core 两棵进程树：并行 worker 负载下单跑约 8s，30s 会偶发超时。
  }, 60_000);

  it("refuses to restart while an update owns the lifecycle lock", async () => {
    const { serverRoot, layout } = await createRoot("nibi-cli-restart-lock-");
    const lock = new DataRootLock(layout.updateLockFile);
    await lock.acquire();
    const { errors, io } = createIo();
    try {
      const exit = await runServerCli(["restart", "--server-root", serverRoot], io);
      expect(exit).toBe(1);
      expect(errors.join("")).toMatch(/update is already running/i);
    } finally {
      await lock.release();
    }
  });
});

describe("stopSupervisorAndWait", () => {
  it("treats a stale lock as already stopped without contacting control", async () => {
    const { layout } = await createRoot("nibi-cli-stop-stale-");
    const lock = new DataRootLock(layout.lockFile);
    await lock.acquire();
    // 把锁改写成不存在的 pid，inspect 应判为 stale。
    await writeFile(
      layout.lockFile,
      `${JSON.stringify({ pid: 999_999_999, startedAt: 1 })}\n`,
      "utf8",
    );
    await expect(stopSupervisorAndWait(layout, "test")).resolves.toBeUndefined();
  });
});
