/**
 * `renderChildEntry` 在 **esbuild 打包 / minify 之后**依然渲染出一份可运行的自包含入口文件。
 *
 * 为什么必须有这条测试：入口文件里的子进程逻辑是 `childMain.toString()` 拼出来的，而真实发布形态
 * 里这个函数先经 esbuild 打包（CLI 是单文件 bundle），desktop-agent 构建还会 minify。一旦
 * childMain 引用了模块作用域的任何绑定（常量、辅助函数、import），打包后那个标识符会被改名或
 * 提到别处，内嵌出来的文本就成了引用未定义标识符的非法程序——而且**只在发布产物里**坏，
 * 源码跑测试全绿。所以这里不测源码形态，专测打包形态，并且不止 `--check` 语法：真 spawn 一次
 * 跑到 complete，因为语法合法的坏程序（比如少了 bootstrap）照样能通过语法检查。
 *
 * esbuild 从 workspace 根解析而来（`apps/nibi-cli/package.json` 的依赖，CLI 的
 * `scripts/build.mjs` 用的是同一份）。
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "esbuild";
import type { renderChildEntry as renderChildEntryType } from "../src/child-source.js";

const ENTRY = new URL("../src/child-source.ts", import.meta.url);

const roots: string[] = [];

afterEach(async () => {
  // 子进程退出与句柄释放之间有一个短窗口（Windows 上 cwd 还挂在已退出的 sandbox 子进程上）：
    // 给有限重试，别把收尾竞态判成用例失败。
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true, maxRetries: 10, retryDelay: 50 }),
    ),
  );
});

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** 打包 child-source.ts 并取出打包产物里的 renderChildEntry（不是源码形态的那一份）。 */
async function bundledRenderChildEntry(minify: boolean): Promise<typeof renderChildEntryType> {
  const root = await tempRoot("dwf-child-bundle-");
  const outfile = join(root, "child-source.mjs");
  await build({
    bundle: true,
    // .pathname 在 Windows 上会给 /D:/...，esbuild 解析不到；必须转成宿主路径。
    entryPoints: [fileURLToPath(ENTRY)],
    format: "esm",
    // 与 CLI 发布构建同参：desktop-agent 是 minify + keepNames，普通/SEA 构建不压缩。
    keepNames: minify,
    minify,
    outfile,
    platform: "node",
    target: "node22",
  });
  const module = (await import(pathToFileURL(outfile).href)) as {
    renderChildEntry: typeof renderChildEntryType;
  };
  return module.renderChildEntry;
}

/** 按 harness 缺省策略写入口文件、真跑一次子进程，返回它写回的 NDJSON 行。 */
async function runChild(
  render: typeof renderChildEntryType,
  payload: { lowered: string; args?: Record<string, unknown> },
): Promise<unknown[]> {
  const root = await tempRoot("dwf-child-entry-");
  const entryPath = join(root, "run.mjs");
  await writeFile(entryPath, render({ ...payload, maxOldSpaceSizeMb: 256 }, { runId: "run" }), "utf8");
  const result = spawnSync(process.execPath, ["--max-old-space-size=256", entryPath], {
    encoding: "utf8",
    input: "",
    timeout: 30_000,
  });
  // 子进程的 stderr 是这条测试唯一的归因材料——ReferenceError 之类会在这里现形。
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  return result.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

/**
 * 与 {@link runChild} 相同的入口文件，但异步地跟子进程对话：每收到一条 request 就回一条
 * response。传输篡改用例必须让一个 request 真的走完 response 投递，才能证明外层用的是引导期
 * 取走的那份入口函数，而不是脚本刚替换掉的全局。
 */
async function runChildWithResponses(
  render: typeof renderChildEntryType,
  payload: { lowered: string; args?: Record<string, unknown> },
): Promise<unknown[]> {
  const root = await tempRoot("dwf-child-entry-");
  const entryPath = join(root, "run.mjs");
  await writeFile(entryPath, render({ ...payload, maxOldSpaceSizeMb: 256 }, { runId: "run" }), "utf8");

  const child = spawn(process.execPath, ["--max-old-space-size=256", entryPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines: unknown[] = [];
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", () => resolve());
  });
  const reader = createInterface({ input: child.stdout! });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("the sandbox child timed out")), 30_000);
      reader.on("line", (line) => {
        if (line.trim().length === 0) return;
        const message = JSON.parse(line) as { kind: string; id?: string };
        lines.push(message);
        if (message.kind === "request") {
          child.stdin!.write(
            `${JSON.stringify({ kind: "response", id: message.id, ok: true, value: "pong" })}\n`,
          );
        }
        if (message.kind === "complete") resolve();
      });
      child.on("error", reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    reader.close();
    // 收尾由父进程 kill（与生产 harness 同规）；这里只等句柄释放，不依赖子进程自然退出。
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
  // 子进程的 stderr 是这条测试唯一的归因材料——ReferenceError / 未捕获异常都会在这里现形。
  expect(stderr).toBe("");
  return lines;
}

describe.each([
  { label: "bundled", minify: false },
  { label: "bundled + minified", minify: true },
])("renderChildEntry ($label)", ({ minify }) => {
  it("runs the sandbox to completion", async () => {
    const render = await bundledRenderChildEntry(minify);

    const lines = await runChild(render, {
      lowered: '__host.log("from the sandbox");\nreturn { ok: 42 };',
    });

    expect(lines).toEqual([
      { kind: "event", type: "log", message: "from the sandbox" },
      { kind: "complete", ok: true, value: { ok: 42 } },
    ]);
  });

  it("keeps the sandbox bans and the curated realm intact", async () => {
    const render = await bundledRenderChildEntry(minify);

    // bootstrap 若被打包丢掉，脚本会拿到一个没有禁令的裸 context——那时这里会返回 ok:true。
    const lines = await runChild(render, {
      lowered: [
        "let bans = [];",
        'try { Date.now(); } catch (e) { bans.push("Date.now"); }',
        'try { Math.random(); } catch (e) { bans.push("Math.random"); }',
        'return { bans, hasProcess: typeof process !== "undefined", hostKeys: Object.keys(__host).sort() };',
      ].join("\n"),
    });

    expect(lines).toEqual([
      {
        kind: "complete",
        ok: true,
        value: {
          bans: ["Date.now", "Math.random"],
          hasProcess: false,
          // Boundary A 的全部成员。产物的两族在这里就分得开：publishArtifact 是效应
          // （request/response），declareArtifact 是声明（事件通道）。
          hostKeys: [
            "args",
            "ask",
            "channel",
            "createActor",
            "declareArtifact",
            "enterPhase",
            "future",
            "hole",
            "log",
            "publishArtifact",
            "report",
            "worldRead",
          ],
        },
      },
    ]);
  });

  it("keeps the realm boundary and removes the host transport from the global", async () => {
    const render = await bundledRenderChildEntry(minify);

    const lines = await runChild(render, {
      lowered: [
        'const probe = (fn) => { try { return "value:" + typeof fn(); } catch (e) { return "threw:" + (e && e.name); } };',
        "return {",
        '  globalCtor: probe(() => globalThis.constructor.constructor("return process")()),',
        '  protoCtor: probe(() => globalThis.__proto__.constructor.constructor("return process")()),',
        '  thisCtor: probe(() => this.constructor.constructor("return process")()),',
        '  escapedEnv: probe(() => globalThis.constructor.constructor("return process.env.PATH")()),',
        `  escapedFs: probe(() => globalThis.constructor.constructor("return require('node:fs').readFileSync")()),`,
        `  escapedFetch: probe(() => globalThis.constructor.constructor("return fetch('http://127.0.0.1')")()),`,
        "  send: typeof globalThis.__send,",
        "  finish: typeof globalThis.__finish,",
        '  hostWritable: (() => { const d = Object.getOwnPropertyDescriptor(globalThis, "__host"); return d ? d.writable : "missing"; })(),',
        '  hasRun: Object.prototype.hasOwnProperty.call(__host, "run"),',
        "};",
      ].join("\n"),
    });

    expect(lines).toEqual([
      {
        kind: "complete",
        ok: true,
        value: {
          // 修复前前三条是 "value:object"（宿主 process 已到手）；打包/压缩形态同样必须拒绝。
          globalCtor: "threw:ReferenceError",
          protoCtor: "threw:ReferenceError",
          thisCtor: "threw:ReferenceError",
          escapedEnv: "threw:ReferenceError",
          escapedFs: "threw:ReferenceError",
          escapedFetch: "threw:ReferenceError",
          send: "undefined",
          finish: "undefined",
          hostWritable: false,
          hasRun: false,
        },
      },
    ]);
  });

  it("captures the transport entries before the script can replace them", async () => {
    const render = await bundledRenderChildEntry(minify);

    const lines = await runChildWithResponses(render, {
      lowered: [
        "const originalDeliver = globalThis.__deliver;",
        "const originalExecute = globalThis.__execute;",
        "const originalCheckStalled = globalThis.__checkStalled;",
        "const transport = {",
        "  sendAtStart: typeof globalThis.__send,",
        "  finishAtStart: typeof globalThis.__finish,",
        "  deliverAtStart: typeof originalDeliver,",
        "  executeAtStart: typeof originalExecute,",
        "  checkStalledAtStart: typeof originalCheckStalled,",
        "};",
        // 全部换成会炸的实现：外层若还在用沙箱对象上的现取引用，deliver / checkStalled 会立刻
        // 把子进程打崩（修复前实测就是 stopped/interrupted + "hijacked checkStalled" 栈）。
        'globalThis.__deliver = function () { throw new Error("hijacked deliver"); };',
        'globalThis.__execute = function () { throw new Error("hijacked execute"); };',
        'globalThis.__checkStalled = function () { throw new Error("hijacked checkStalled"); };',
        'globalThis.__send = function () { throw new Error("hijacked send"); };',
        'globalThis.__finish = function () { throw new Error("hijacked finish"); };',
        "transport.deliverReplaced = globalThis.__deliver !== originalDeliver;",
        "transport.executeReplaced = globalThis.__execute !== originalExecute;",
        "transport.checkStalledReplaced = globalThis.__checkStalled !== originalCheckStalled;",
        'const actor = __host.createActor("actor#1", "w");',
        'const answer = await __host.ask("ask#1", actor, "hi");',
        "return { answer, transport };",
      ].join("\n"),
    });

    expect(lines).toEqual([
      { kind: "create-actor", localId: "local#1", siteId: "actor#1", name: "w" },
      {
        kind: "request",
        id: "r1",
        type: "ask",
        siteId: "ask#1",
        actor: "local#1",
        instructions: "hi",
      },
      {
        kind: "complete",
        ok: true,
        value: {
          // response 由外层用引导期取走的 deliver 投递进来——脚本替换过的那个从未被调用。
          answer: "pong",
          transport: {
            sendAtStart: "undefined",
            finishAtStart: "undefined",
            deliverAtStart: "function",
            executeAtStart: "function",
            checkStalledAtStart: "function",
            deliverReplaced: true,
            executeReplaced: true,
            checkStalledReplaced: true,
          },
        },
      },
    ]);
  });
});
