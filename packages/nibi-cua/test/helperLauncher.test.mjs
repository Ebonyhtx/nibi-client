/**
 * Helper 自拉（SDK 首调路径）测试。
 *
 * 为什么要有这组：上游 v3.15.1 把 Helper 懒启动的"自拉"那一半留在闭源侧，
 * 只把配方当纯数据注入 spawn env。我们补上了这一半（../helper-launcher.js），
 * 它是**电脑操控能不能用的唯一入口**——没有它，每次 CUA 调用都以
 * broker_not_accepting 收场（真机 2026-10-13 实测）。
 *
 * 判据覆盖：配方解析的边界、fork 参数与握手协议的逐项对齐、失败路径不许静默成功、
 * 幂等（不重复 fork 抢同一个 pipe）。全部离线（用假 helper 脚本与注入的 spawnImpl）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import {
  HELPER_ADDON_ENV,
  HELPER_CONTROL_PROTOCOL,
  HELPER_RECIPE_ENV,
  createHelperLauncher,
  parseHelperRecipe,
  spawnCuaHelper,
} from "../helper-launcher.js";

const RECIPE = {
  command: "C:\\fake\\electron.exe",
  entryPath: "C:\\fake\\helper\\main.js",
  root: "C:\\fake\\cua-helper",
  addonPath: "C:\\fake\\node_modules\\@trycua\\driver.node",
  commandEnv: { ELECTRON_RUN_AS_NODE: "1" },
};

/** 假子进程：可编程地发握手消息 / 退出，并记录收到的 spawn 参数。 */
function createFakeChild() {
  const child = new EventEmitter();
  child.pid = 4242;
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

function fakeSpawn(spawned, plan = {}) {
  return (command, argv, options) => {
    const child = createFakeChild();
    spawned.push({ command, argv, options, child });
    // 默认在下一个 tick 发 transport_ready（模拟 helper 绑好 pipe）。
    queueMicrotask(() => {
      if (plan.error) return; // 什么都不发 → 走超时
      if (plan.exitBeforeReady) {
        child.emit("exit", 1, null);
        return;
      }
      child.emit("message", {
        protocol: HELPER_CONTROL_PROTOCOL,
        type: "transport_ready",
        socketPath: options.socketPathForTest ?? plan.socketPath ?? "\\\\.\\pipe\\x",
        pid: child.pid,
      });
    });
    return child;
  };
}

test("配方解析：缺字段一律 null（绝不猜路径）", () => {
  assert.equal(parseHelperRecipe(undefined), null, "undefined");
  assert.equal(parseHelperRecipe(""), null, "空串");
  assert.equal(parseHelperRecipe("{"), null, "坏 JSON");
  assert.equal(parseHelperRecipe(JSON.stringify({ command: "a" })), null, "缺 entryPath/root");
  assert.equal(
    parseHelperRecipe(JSON.stringify({ ...RECIPE, entryPath: "  " })),
    null,
    "entryPath 只有空白",
  );
  const ok = parseHelperRecipe(JSON.stringify(RECIPE));
  assert.equal(ok.command, RECIPE.command);
  assert.equal(ok.addonPath, RECIPE.addonPath);
});

test("配方解析：commandEnv 只保留字符串值，非对象降级为空", () => {
  const parsed = parseHelperRecipe(
    JSON.stringify({ ...RECIPE, commandEnv: { A: "1", B: 2, C: null } }),
  );
  assert.deepEqual(parsed.commandEnv, { A: "1" }, "数字/空值被剔除");
  const noEnv = parseHelperRecipe(JSON.stringify({ ...RECIPE, commandEnv: "nope" }));
  assert.deepEqual(noEnv.commandEnv, {}, "非对象降级为空");
});

test("fork 契约与宿主侧逐项对齐（argv/cwd/env 三处，错一处 helper 起不来）", async () => {
  const spawned = [];
  const socketPath = "\\\\.\\pipe\\nibi-test";
  const handle = await spawnCuaHelper({
    recipe: RECIPE,
    socketPath,
    parentPid: 777,
    spawnImpl: fakeSpawn(spawned, { socketPath }),
  });

  assert.equal(spawned.length, 1, "只 fork 一次");
  const call = spawned[0];
  assert.equal(call.command, RECIPE.command, "command 用配方里的");
  assert.deepEqual(
    call.argv,
    [RECIPE.entryPath, "--socket", socketPath, "--parent-pid", "777"],
    "argv 顺序必须与宿主一致：entry --socket <pipe> --parent-pid <pid>",
  );
  assert.equal(call.options.cwd, RECIPE.root, "cwd 用 root（helper 靠它找相对资源）");
  assert.equal(call.options.env[HELPER_ADDON_ENV], RECIPE.addonPath, "注入原生件路径");
  assert.equal(call.options.env.ELECTRON_RUN_AS_NODE, "1", "Electron 必须走 node 模式");
  assert.deepEqual(call.options.stdio, ["ignore", "pipe", "pipe", "ipc"], "需要 ipc 通道握手");
  assert.equal(call.options.windowsHide, true, "后台 Helper 不得创建可见控制台窗口");
  assert.equal(handle.socketPath, socketPath);
});

test("握手校验：socket 不一致 / pid 不一致 / helper 报 error 都必须失败", async () => {
  const cases = [
    {
      name: "socket 不一致",
      message: { protocol: HELPER_CONTROL_PROTOCOL, type: "transport_ready", socketPath: "\\\\.\\pipe\\other", pid: 4242 },
      expect: /different socket path/,
    },
    {
      name: "pid 不一致",
      message: { protocol: HELPER_CONTROL_PROTOCOL, type: "transport_ready", socketPath: "\\\\.\\pipe\\nibi-test", pid: 9999 },
      expect: /different pid/,
    },
    {
      name: "helper 报错",
      message: { protocol: HELPER_CONTROL_PROTOCOL, type: "error", message: "引擎加载失败" },
      expect: /引擎加载失败/,
    },
  ];
  for (const item of cases) {
    const spawned = [];
    const spawnImpl = (command, argv, options) => {
      const child = createFakeChild();
      spawned.push({ command, argv, options, child });
      queueMicrotask(() => child.emit("message", item.message));
      return child;
    };
    await assert.rejects(
      () =>
        spawnCuaHelper({
          recipe: RECIPE,
          socketPath: "\\\\.\\pipe\\nibi-test",
          spawnImpl,
        }),
      item.expect,
      item.name,
    );
    assert.equal(spawned[0].child.killed, true, `${item.name}：失败必须顺手杀掉子进程`);
  }
});

test("helper 还没握手就退出 → 明确失败，绝不静默成功", async () => {
  const spawned = [];
  await assert.rejects(
    () =>
      spawnCuaHelper({
        recipe: RECIPE,
        socketPath: "\\\\.\\pipe\\nibi-test",
        spawnImpl: fakeSpawn(spawned, { exitBeforeReady: true }),
      }),
    /exited before transport_ready/,
  );
});

test("缺配方 / 缺 socket → 立刻拒绝，不 fork", async () => {
  const spawned = [];
  await assert.rejects(
    () => spawnCuaHelper({ recipe: null, socketPath: "\\\\.\\pipe\\x", spawnImpl: fakeSpawn(spawned) }),
    /missing helper recipe/,
  );
  await assert.rejects(
    () => spawnCuaHelper({ recipe: RECIPE, socketPath: "", spawnImpl: fakeSpawn(spawned) }),
    /missing broker socket path/,
  );
  assert.equal(spawned.length, 0, "拒绝路径不许 fork");
});

test("launcher 幂等：并发 ensure 只 fork 一次（否则多个 helper 抢同一个 pipe）", async () => {
  const spawned = [];
  const launcher = createHelperLauncher({
    socketPath: "\\\\.\\pipe\\nibi-test",
    env: { [HELPER_RECIPE_ENV]: JSON.stringify(RECIPE) },
    spawnImpl: fakeSpawn(spawned, { socketPath: "\\\\.\\pipe\\nibi-test" }),
  });
  await Promise.all([launcher.ensure(), launcher.ensure(), launcher.ensure()]);
  assert.equal(spawned.length, 1, "三次并发只 fork 一次");
  await launcher.ensure();
  assert.equal(spawned.length, 1, "已成功后再调不重复 fork");
});

test("launcher：没有配方时 available=false 且不 fork（保持 fail-closed）", async () => {
  const spawned = [];
  const launcher = createHelperLauncher({
    socketPath: "\\\\.\\pipe\\nibi-test",
    env: {},
    spawnImpl: fakeSpawn(spawned),
  });
  assert.equal(launcher.available, false, "无配方即不可用");
  assert.match(launcher.reason, /HELPER_RECIPE/, "理由要指出缺哪个变量");
  await assert.rejects(() => launcher.ensure(), /HELPER_RECIPE/);
  assert.equal(spawned.length, 0, "不可用时绝不 fork");
});

test("launcher：失败后可重试（helper 崩溃不该把会话锁死）", async () => {
  const spawned = [];
  let attempt = 0;
  const spawnImpl = (command, argv, options) => {
    const child = createFakeChild();
    spawned.push(child);
    attempt += 1;
    queueMicrotask(() => {
      if (attempt === 1) {
        child.emit("exit", 1, null);
        return;
      }
      child.emit("message", {
        protocol: HELPER_CONTROL_PROTOCOL,
        type: "transport_ready",
        socketPath: "\\\\.\\pipe\\nibi-test",
        pid: child.pid,
      });
    });
    return child;
  };
  const launcher = createHelperLauncher({
    socketPath: "\\\\.\\pipe\\nibi-test",
    env: { [HELPER_RECIPE_ENV]: JSON.stringify(RECIPE) },
    spawnImpl,
  });
  await assert.rejects(() => launcher.ensure(), /exited before transport_ready/);
  await launcher.ensure();
  assert.equal(spawned.length, 2, "第一次失败、第二次成功");
});
