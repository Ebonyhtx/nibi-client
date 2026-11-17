/**
 * 沙箱安全：vm.createContext 求值单元的隔离契约（docs/execution-engine.md 的"The sandbox"）。
 * 这些脚本按设计**无法**通过 facade typecheck（直接摸 process/import 等），故绕开编译器，把手写的
 * lowered 函数体直接喂 harness——vm 契约本身才是被测对象，这是正当做法。
 */

import { describe, expect, it } from "vitest";
import { InMemoryJournalStore, type AskSpec, type RunSettlement } from "@nibi/dynamic-workflow";
import { runWorkflowScript } from "../src/index.js";
import { AutoDriver, type AutoDriverConfig } from "./auto-driver.js";
import { TEST_CWD } from "./helpers.js";

interface RunLoweredOptions {
  /** ask 站点的应答器（篡改传输全局后仍要能完成一次 request/response）。 */
  asks?: AutoDriverConfig["asks"];
  /** 引擎要求覆盖脚本里的每个 ask 站点；只有带 ask 的用例需要。 */
  askSpecs?: Map<string, AskSpec>;
}

const untyped = (...ids: string[]): Map<string, AskSpec> =>
  new Map(ids.map((id) => [id, { typed: false } as AskSpec]));

/** 直接投喂手写 lowered 体（自由标识符仅 `__host`），返回结算。 */
async function runLowered(
  lowered: string,
  opts: RunLoweredOptions = {},
): Promise<RunSettlement> {
  const journal = new InMemoryJournalStore();
  const driver = new AutoDriver(journal, { asks: opts.asks });
  return runWorkflowScript({
    cwd: TEST_CWD,
    lowered,
    caps: { maxConcurrency: 4 },
    askSpecs: opts.askSpecs ?? new Map(),
    validate: () => [],
    makeDriver: (sink) => {
      driver.attach(sink);
      return driver;
    },
    timeoutMs: 15000,
  });
}

/** 便捷：跑一个直接 return 表达式的沙箱体，取回 artifact。 */
async function evalInSandbox(expr: string): Promise<unknown> {
  const settlement = await runLowered(`return ${expr};`);
  expect(settlement.status).toBe("completed");
  return (settlement as { status: "completed"; artifact: unknown }).artifact;
}

describe("sandbox security — Node globals are absent", () => {
  it("process / fetch / require / globalThis.process are undefined", async () => {
    expect(await evalInSandbox('typeof process')).toBe("undefined");
    expect(await evalInSandbox('typeof fetch')).toBe("undefined");
    expect(await evalInSandbox('typeof require')).toBe("undefined");
    expect(await evalInSandbox('typeof globalThis.process')).toBe("undefined");
    expect(await evalInSandbox('typeof Buffer')).toBe("undefined");
    expect(await evalInSandbox('typeof global')).toBe("undefined");
  });

  it("ES intrinsics are present (curated globals, not a stripped realm)", async () => {
    expect(await evalInSandbox('typeof JSON')).toBe("object");
    expect(await evalInSandbox('typeof Promise')).toBe("function");
    expect(await evalInSandbox('Array.isArray([1,2])')).toBe(true);
  });
});

describe("sandbox security — dynamic import throws", () => {
  it("import() rejects with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING", async () => {
    const result = await evalInSandbox(
      '(await (async () => { try { await import("node:fs"); return "NO-THROW"; } catch (e) { return String(e && (e.code || e.name)); } })())',
    );
    expect(result).toContain("ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING");
  });
});

describe("sandbox security — runtime nondeterminism bans (belt)", () => {
  it("Date.now() throws", async () => {
    expect(await evalInSandbox('(() => { try { Date.now(); return "NO"; } catch (e) { return e.message; } })()')).toContain(
      "Date.now()",
    );
  });

  it("argless new Date() throws; new Date(ms) is allowed", async () => {
    expect(await evalInSandbox('(() => { try { new Date(); return "NO"; } catch (e) { return e.message; } })()')).toContain(
      "argless new Date()",
    );
    // 带参构造仍可用（只有不确定性的无参形态被禁）。
    expect(await evalInSandbox("new Date(0).getTime()")).toBe(0);
  });

  it("Math.random() throws", async () => {
    expect(
      await evalInSandbox('(() => { try { Math.random(); return "NO"; } catch (e) { return e.message; } })()'),
    ).toContain("Math.random()");
  });
});

describe("sandbox security — eval binds to the same curated globals", () => {
  it('eval("process") sees undefined; eval("Date.now()") throws', async () => {
    // 动态创建的代码也绑定同一套 curated 全局：证明隔离不是靠静态改写脚本文本。
    expect(await evalInSandbox('eval("typeof process")')).toBe("undefined");
    expect(await evalInSandbox('(() => { try { eval("Date.now()"); return "NO"; } catch (e) { return "THREW"; } })()')).toBe(
      "THREW",
    );
  });
});

/**
 * realm 边界：脚本只要摸到一个**外层 realm** 的函数或对象，`.constructor.constructor` 就是外层的
 * Function，`Function("return process")()` 即宿主 process（零审批执行任意命令）。修复前
 * `globalThis.constructor.constructor("return process")()` 直接返回宿主 process（typeof 为 object），
 * `globalThis.__send.constructor.constructor` 同理；根因是沙箱对象带外层 Object.prototype、且两个
 * 宿主传输函数留在全局上（见 child-source.ts 沙箱构造处的四条规则）。这里只把 typeof / 异常名
 * 带出沙箱，绝不把宿主对象本身放进 case 的 artifact。
 */
describe("sandbox security — realm boundary (constructor.constructor)", () => {
  it("every intrinsic-derived constructor chain stays in the cell realm", async () => {
    const result = await evalInSandbox(`(() => {
      const probe = (fn) => {
        try { return "value:" + typeof fn(); } catch (e) { return "threw:" + (e && e.name); }
      };
      return {
        globalThisCtor: probe(() => globalThis.constructor.constructor("return process")()),
        globalProtoCtor: probe(() => globalThis.__proto__.constructor.constructor("return process")()),
        bareProtoCtor: probe(() => ({}).__proto__.constructor.constructor("return process")()),
        thisCtor: probe(() => this.constructor.constructor("return process")()),
        bareObject: probe(() => ({}).constructor.constructor("return process")()),
        bareArray: probe(() => [].constructor.constructor("return process")()),
        functionLiteral: probe(() => (function () {}).constructor("return process")()),
        evalCtor: probe(() => eval.constructor("return process")()),
        hostFunction: probe(() => __host.ask.constructor.constructor("return process")()),
        hostObject: probe(() => __host.constructor.constructor("return process")()),
      };
    })()`);
    expect(result).toEqual({
      // "return process" 在 cell 里求值只能撞上未声明的标识符：隔离成立时是 ReferenceError，
      // 逃逸成立时则会把宿主 process 原样返回（修复前实测为 "value:object"）。
      globalThisCtor: "threw:ReferenceError",
      globalProtoCtor: "threw:ReferenceError",
      bareProtoCtor: "threw:ReferenceError",
      thisCtor: "threw:ReferenceError",
      bareObject: "threw:ReferenceError",
      bareArray: "threw:ReferenceError",
      functionLiteral: "threw:ReferenceError",
      evalCtor: "threw:ReferenceError",
      hostFunction: "threw:ReferenceError",
      hostObject: "threw:ReferenceError",
    });
  });

  it("process.env, fs and network are unreachable through Function / constructor / import()", async () => {
    const result = await evalInSandbox(`(async () => {
      const probe = (fn) => {
        try { return "value:" + typeof fn(); } catch (e) { return "threw:" + (e && e.name); }
      };
      // 逃逸的原始形态：如果 globalThis.constructor.constructor 还是外层 Function，下面每一条
      // 都会在宿主 realm 求值并拿到 capabilities 的 typeof（修复前实测全是 "value:string"）。
      // 只探 typeof、不实际调用 fs / 网络，避免用例本身产生副作用。
      const escaped = (source) => globalThis.constructor.constructor(source);
      const importProbe = async (spec) => {
        try { await import(spec); return "value:imported"; } catch (e) { return "threw:" + (e && (e.code || e.name)); }
      };
      return {
        processType: typeof process,
        env: probe(() => Function("return process.env")()),
        cwd: probe(() => Function("return process.cwd()")()),
        fs: probe(() => Function("return require('node:fs')")()),
        readFile: probe(() => Function("return require('node:fs').readFileSync")()),
        http: probe(() => Function("return require('node:http')")()),
        net: probe(() => Function("return require('node:net')")()),
        fetch: probe(() => Function("return fetch('http://127.0.0.1')")()),
        global: probe(() => Function("return global")()),
        buffer: probe(() => Function("return Buffer")()),
        escapeEnv: probe(() => escaped("return typeof process.env.PATH")()),
        escapeCwd: probe(() => escaped("return typeof process.cwd()")()),
        escapeFs: probe(() => escaped("return typeof process.getBuiltinModule('node:fs').readFileSync")()),
        escapeHttp: probe(() => escaped("return typeof process.getBuiltinModule('node:http')")()),
        escapeFetch: probe(() => escaped("return fetch")()),
        importFs: await importProbe("node:fs"),
        importHttp: await importProbe("node:http"),
      };
    })()`);
    expect(result).toEqual({
      processType: "undefined",
      env: "threw:ReferenceError",
      cwd: "threw:ReferenceError",
      fs: "threw:ReferenceError",
      readFile: "threw:ReferenceError",
      http: "threw:ReferenceError",
      net: "threw:ReferenceError",
      fetch: "threw:ReferenceError",
      global: "threw:ReferenceError",
      buffer: "threw:ReferenceError",
      escapeEnv: "threw:ReferenceError",
      escapeCwd: "threw:ReferenceError",
      escapeFs: "threw:ReferenceError",
      escapeHttp: "threw:ReferenceError",
      escapeFetch: "threw:ReferenceError",
      importFs: "threw:ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING",
      importHttp: "threw:ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING",
    });
  });
});

describe("sandbox security — transport globals are captured before the script runs", () => {
  it("removes __send / __finish from the global before any script code runs", async () => {
    expect(
      await evalInSandbox(`({
        send: typeof globalThis.__send,
        finish: typeof globalThis.__finish,
        ownSend: Object.prototype.hasOwnProperty.call(globalThis, "__send"),
        ownFinish: Object.prototype.hasOwnProperty.call(globalThis, "__finish"),
      })`),
    ).toEqual({ send: "undefined", finish: "undefined", ownSend: false, ownFinish: false });
  });

  it("replacing __deliver / __execute / __checkStalled / __send / __finish cannot hijack transport", async () => {
    const settlement = await runLowered(
      [
        'const actor = __host.createActor("actor#1", "w");',
        "const originalDeliver = globalThis.__deliver;",
        "const originalExecute = globalThis.__execute;",
        "const originalCheckStalled = globalThis.__checkStalled;",
        "const sendAtStart = typeof globalThis.__send;",
        "const finishAtStart = typeof globalThis.__finish;",
        // 五个全局全部换成会炸的实现：外层若还从沙箱对象现取现调，任何一条都会把子进程打崩。
        'globalThis.__deliver = function () { throw new Error("hijacked deliver"); };',
        'globalThis.__execute = function () { throw new Error("hijacked execute"); };',
        'globalThis.__checkStalled = function () { throw new Error("hijacked checkStalled"); };',
        'globalThis.__send = function () { throw new Error("hijacked send"); };',
        'globalThis.__finish = function () { throw new Error("hijacked finish"); };',
        'const answer = await __host.ask("ask#1", actor, "hi");',
        "return {",
        "  answer,",
        "  sendAtStart,",
        "  finishAtStart,",
        "  deliverReplaced: globalThis.__deliver !== originalDeliver,",
        "  executeReplaced: globalThis.__execute !== originalExecute,",
        "  checkStalledReplaced: globalThis.__checkStalled !== originalCheckStalled,",
        "};",
      ].join("\n"),
      {
        askSpecs: untyped("ask#1"),
        asks: { "ask#1": () => ({ type: "text", finalText: "still here" }) },
      },
    );
    expect(settlement).toEqual({
      status: "completed",
      artifact: {
        answer: "still here",
        sendAtStart: "undefined",
        finishAtStart: "undefined",
        deliverReplaced: true,
        executeReplaced: true,
        checkStalledReplaced: true,
      },
    });
  });
});

describe("sandbox security — __host compatibility surface", () => {
  it("is readable but not writable, and carries no run identity", async () => {
    const result = await evalInSandbox(`(() => {
      const descriptor = Object.getOwnPropertyDescriptor(globalThis, "__host");
      let rewrite;
      try { globalThis.__host = null; rewrite = "assigned"; } catch (e) { rewrite = "threw:" + e.name; }
      return {
        writable: descriptor ? descriptor.writable : "missing",
        configurable: descriptor ? descriptor.configurable : "missing",
        rewrite,
        hostAfter: typeof globalThis.__host,
        askAfter: typeof __host.ask,
        hasRunOwn: Object.prototype.hasOwnProperty.call(__host, "run"),
        runIn: "run" in __host,
        keys: Object.keys(__host).sort(),
      };
    })()`);
    expect(result).toMatchObject({
      writable: false,
      configurable: false,
      hostAfter: "object",
      askAfter: "function",
      // NIBI 相对上游刻意删掉了 run 身份：这条断言钉住现状，防止将来套用上游整段时误加回来。
      hasRunOwn: false,
      runIn: false,
      keys: [
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
    });
    // 非严格模式下给不可写全局赋值是静默 no-op；若将来 lowered 体变 strict，则是 TypeError。
    // 两种都不是"改掉了"——hostAfter/askAfter 已经证明它没被改成 null。
    expect(["assigned", "threw:TypeError"]).toContain((result as { rewrite: string }).rewrite);
  });
});
