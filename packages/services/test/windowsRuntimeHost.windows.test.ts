import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveWindowsRuntimeHostHelper,
  spawnWindowsRuntimeHost,
  type WindowsRuntimeHost,
} from "@nibi/services/windows-runtime-host";

async function findHelper(): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  try {
    return await resolveWindowsRuntimeHostHelper();
  } catch {
    return undefined;
  }
}

const helper = await findHelper();

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilGone(pids: number[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isRunning(pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(pids.filter(isRunning)).toEqual([]);
}

interface TreeFixture {
  runtime: WindowsRuntimeHost;
  rootPid: number;
  childPid: number;
  dir: string;
}

async function startTree(): Promise<TreeFixture> {
  const dir = await mkdtemp(join(tmpdir(), "nibi-runtime-host-test-"));
  const script = join(dir, "parent.mjs");
  // Root CLI spawns a grandchild and keeps running; both must die with the Job.
  await writeFile(
    script,
    [
      'import { spawn } from "node:child_process";',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      "process.stdout.write(`CHILD ${child.pid}\\n`);",
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  const runtime = await spawnWindowsRuntimeHost({
    command: process.execPath,
    args: [script],
    cwd: dir,
    env: process.env,
    signal: new AbortController().signal,
  });
  const childPid = new Promise<number>((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(() => reject(new Error("parent did not report its child pid")), 15_000);
    const onData = (chunk: string) => {
      buffered += chunk;
      const match = /CHILD (\d+)/.exec(buffered);
      if (!match) return;
      clearTimeout(timer);
      runtime.child.stdout.off("data", onData);
      resolve(Number(match[1]));
    };
    runtime.child.stdout.setEncoding("utf8");
    runtime.child.stdout.on("data", onData);
  });
  const rootPid = await runtime.ready();
  await runtime.start();
  return { runtime, rootPid, childPid: await childPid, dir };
}

async function cleanup(fixture: TreeFixture | undefined): Promise<void> {
  if (!fixture) return;
  await fixture.runtime.close(Date.now() + 5_000).catch(() => undefined);
  await rm(fixture.dir, { recursive: true, force: true });
}

describe.skipIf(helper === undefined)("windows-runtime-host Job ownership", () => {
  it("does not let the subtree survive a runtime host crash", async () => {
    const fixture = await startTree();
    try {
      expect(isRunning(fixture.rootPid)).toBe(true);
      expect(isRunning(fixture.childPid)).toBe(true);
      // Simulate Host/Main crash: the helper is the only Job handle owner.
      fixture.runtime.child.kill();
      await waitUntilGone([fixture.rootPid, fixture.childPid], 15_000);
    } finally {
      await cleanup(fixture);
    }
  });

  it("kills descendants when the CLI parent process dies", async () => {
    const fixture = await startTree();
    try {
      expect(isRunning(fixture.childPid)).toBe(true);
      // The helper sees root exit and terminates the Job; the grandchild must follow.
      process.kill(fixture.rootPid);
      await waitUntilGone([fixture.rootPid, fixture.childPid], 15_000);
    } finally {
      await cleanup(fixture);
    }
  });

  it("kills the whole tree when the Job is closed", async () => {
    const fixture = await startTree();
    try {
      expect(isRunning(fixture.childPid)).toBe(true);
      await fixture.runtime.close(Date.now() + 8_000);
      await waitUntilGone([fixture.rootPid, fixture.childPid], 5_000);
    } finally {
      await cleanup(fixture);
    }
  });
});
