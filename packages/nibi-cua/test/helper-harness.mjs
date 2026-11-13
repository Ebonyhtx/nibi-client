/**
 * 测试脚手架：真的 fork 一个 Helper（真的绑命名管道/Unix socket），等它的 transport_ready。
 * 引擎由调用方指定（假引擎或真 @trycua/cua-driver），因此同一套测试既能离线跑也能真机跑。
 */
import { fork } from "node:child_process";
import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mintEphemeralBrokerSocketPath } from "../broker.js";

const HERE = dirname(fileURLToPath(import.meta.url));
export const HELPER_ENTRY = join(HERE, "..", "helper", "main.js");
export const FAKE_ENGINE = join(HERE, "fake-cua-driver.mjs");

export async function startHelper({ engineModule, env = {} } = {}) {
  // 测试并发跑多个 Helper → 必须用临时端点，不能占稳定端点（那是产品链路的名字）。
  const socketPath = mintEphemeralBrokerSocketPath();
  const child = fork(HELPER_ENTRY, ["--socket", socketPath, "--parent-pid", String(process.pid)], {
    env: { ...process.env, ...env, NIBI_CUA_ENGINE_MODULE: engineModule },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const messages = [];
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`等待 transport_ready 超时；stderr=${stderr}`)),
      30_000,
    );
    child.on("message", (message) => {
      messages.push(message);
      if (message?.type === "transport_ready") {
        clearTimeout(timer);
        resolve(message);
      }
      if (message?.type === "error") {
        clearTimeout(timer);
        reject(new Error(`Helper 启动失败：${message.message}`));
      }
    });
    child.once("exit", (code) => {
      if (messages.some((message) => message?.type === "transport_ready")) return;
      clearTimeout(timer);
      reject(new Error(`Helper 在握手前退出（code=${code}）；stderr=${stderr}`));
    });
  });
  const handshake = await ready;
  return { child, socketPath: handshake.socketPath, messages, stderr: () => stderr };
}

export async function stopHelper(handle) {
  if (handle.child.connected) {
    try {
      handle.child.send({ protocol: "nibi-cua-windows-dev/v1", type: "shutdown" });
    } catch {
      // 通道刚好关了：下面统一按退出码处理。
    }
  }
  await Promise.race([once(handle.child, "exit"), new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (handle.child.exitCode === null && handle.child.signalCode === null) handle.child.kill("SIGKILL");
}
