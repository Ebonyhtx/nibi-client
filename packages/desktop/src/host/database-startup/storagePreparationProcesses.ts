import { realpath } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { Worker } from "node:worker_threads";
import { createInterface } from "node:readline";
import {
  type DatabaseMigrationFacts,
  nibiStoragePreparationFrameSchema,
  type DatabaseStartupState,
} from "@nibi/shared";
import { resolveDefaultNibiAgentCommand } from "@nibi/services/storage-startup";

type Phase = NonNullable<DatabaseStartupState["databasePhase"]>;
import { workerMessageSchema } from "./contract.js";
const statusError = (
  kind: string,
  details?: {
    sqliteCode?: number;
    systemCode?: string;
    migrationId?: string;
    migration?: DatabaseMigrationFacts;
  },
  databaseId?: string,
) =>
  Object.assign(new Error(`Storage preparation failed: ${kind}`), {
    kind,
    errcode: details?.sqliteCode,
    code: details?.systemCode,
    migrationId: details?.migrationId,
    migrationUpdate:
      databaseId && details?.migration ? { databaseId, migration: details.migration } : undefined,
  });

export function prepareHostStorage(
  path: string,
  report: (phase: Phase, migration?: DatabaseMigrationFacts) => void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./tasksStorageWorker.js", import.meta.url), {
      workerData: { path },
    });
    let done = false;
    let failure: unknown;
    let firstState = false;
    const firstStateTimer = setTimeout(() => {
      failure = statusError("startup_status_timeout");
      void worker.terminate();
    }, 30_000);
    const abort = () => {
      failure = statusError("transport_closed");
      void worker.terminate();
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.on("message", (raw: unknown) => {
      const result = workerMessageSchema.safeParse(raw);
      if (!result.success) {
        failure = statusError("transport_closed");
        void worker.terminate();
        return;
      }
      firstState = true;
      clearTimeout(firstStateTimer);
      const message = result.data;
      if (message.type === "progress") report(message.phase, message.migration);
      else if (message.type === "done") done = true;
      else failure = statusError(message.errorCode, message, "tasks-index");
    });
    worker.once("error", (error) => {
      failure = error;
    });
    worker.once("exit", (code) => {
      clearTimeout(firstStateTimer);
      signal.removeEventListener("abort", abort);
      if (done && code === 0 && !failure && firstState) resolve();
      else reject(failure ?? statusError("transport_closed"));
    });
    if (signal.aborted) abort();
  });
}

type StoragePrepareOptions = {
  cwd: string;
  env?: Record<string, string>;
  signal: AbortSignal;
  report: (
    phase: Phase,
    details?: { databaseId: string; migration?: DatabaseMigrationFacts },
  ) => void;
  preparedPaths?: Set<string>;
  observePath: (path: string) => Promise<void>;
};

/** 在 Host 所属 Worker 运行同一 CLI bundle 的存储入口；Host 退出不会留下持锁孤儿进程。
 *  Rust 内核没有 JS 入口（原生 binary 进不了 Worker 线程），走 `storagePreparationProcess` 的
 *  子进程分支（同一段握手，见 runStorageHandshakeLines）。 */
export async function prepareSessionStorage(options: StoragePrepareOptions): Promise<void> {
  const command = resolveDefaultNibiAgentCommand({
    workspacePath: options.cwd,
    workspaceKey: options.cwd,
    presentationSurface: "desktop",
  });
  if (!command?.supportsStorageStartup) throw statusError("unsupported_runtime");
  if (command.storagePreparationProcess) {
    await prepareSessionStorageProcess(command, options);
    return;
  }
  if (!command.storagePreparationEntry) throw statusError("unsupported_runtime");
  const child = new Worker(command.storagePreparationEntry, {
    argv: ["app-server", "--stdio", "--prepare-storage", "--cwd", command.cwd ?? options.cwd],
    env: { ...process.env, ...options.env, ...command.env },
    stdin: true,
    stdout: true,
    stderr: true,
  });
  await runStorageHandshakeLines({
    stdin: child.stdin!,
    stdout: child.stdout!,
    discard: () => child.stderr!.resume(),
    endInput: () => void child.stdin!.end(),
    onExit: (handler) => child.once("exit", (code) => handler(code === 0)),
    onError: (handler) => child.once("error", (error) => handler(error)),
    terminate: () => void child.terminate(),
    options,
  });
}

/** Rust 内核的存储准备：`app-server --stdio --prepare-storage` 原生子进程（cwd 由 spawn 给出，
 *  Rust 的入口只认进程 cwd，没有 `--cwd` 参数）。 */
async function prepareSessionStorageProcess(
  command: NonNullable<ReturnType<typeof resolveDefaultNibiAgentCommand>>,
  options: StoragePrepareOptions,
): Promise<void> {
  const child = spawn(command.command, [...(command.args ?? []), "--prepare-storage"], {
    cwd: command.cwd ?? options.cwd,
    env: { ...process.env, ...options.env, ...command.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  await runStorageHandshakeLines({
    stdin: child.stdin!,
    stdout: child.stdout!,
    discard: () => child.stderr!.resume(),
    endInput: () => void child.stdin!.end(),
    onExit: (handler) => child.once("exit", (code) => handler(code === 0)),
    onError: (handler) => child.once("error", (error) => handler(error)),
    terminate: () => child.kill(),
    options,
  });
}

/** 握手本体（Node `prepareProtocolStartupStorage` 的 Host 侧）：storagePath → 观测边界 →
 *  storagePathReady → storageState 进度 → storagePrepared；30 秒首帧门与失败分类两种 transport 共用。 */
function runStorageHandshakeLines({
  stdin,
  stdout,
  discard,
  endInput,
  onExit,
  onError,
  terminate,
  options,
}: {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  discard: () => void;
  endInput: () => void;
  onExit: (handler: (success: boolean) => void) => void;
  onError: (handler: (error: unknown) => void) => void;
  terminate: () => void;
  options: StoragePrepareOptions;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const lines = createInterface({ input: stdout });
    let settled = false;
    let prepared = false;
    let pathReceived = false;
    let preparedPath: string | undefined;
    let failure: unknown;
    const abort = () => {
      failure ??= statusError("transport_closed");
      terminate();
    };
    const firstStateTimer = setTimeout(() => {
      failure = statusError("startup_status_timeout");
      terminate();
    }, 30_000);
    options.signal.addEventListener("abort", abort, { once: true });
    // stdout 只有有界控制帧，stderr 排空但不把可能含本地路径的原始文本上报。
    discard();
    stdin.on("error", (error) => {
      failure ??= error;
      terminate();
    });
    lines.on("line", (line) => {
      try {
        if (line.length > 65536) throw statusError("transport_closed");
        const frame = nibiStoragePreparationFrameSchema.parse(JSON.parse(line));
        clearTimeout(firstStateTimer);
        if (frame.method === "startup/storagePath") {
          if (pathReceived) throw statusError("transport_closed");
          pathReceived = true;
          void (async () => {
            // 仅复用同一次准备中已成功关闭的真实库，不能按不同 cwd 误判为不同数据库。
            preparedPath = await realpath(frame.params.path).catch(
              (error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") return resolvePath(frame.params.path);
                throw error;
              },
            );
            if (settled || failure || options.signal.aborted) return;
            const reuse = options.preparedPaths?.has(preparedPath) ?? false;
            if (!reuse) await options.observePath(frame.params.path);
            if (!settled && !failure && !options.signal.aborted)
              stdin.write(`${JSON.stringify({ method: "startup/storagePathReady", reuse })}\n`);
          })().catch((error) => {
            failure ??= error;
            terminate();
          });
        } else if (frame.method === "startup/storagePrepared") {
          prepared = pathReceived;
          endInput();
        } else if (frame.params.phase === "failed")
          failure ??= statusError(
            frame.params.errorCode ?? "sql_failed",
            frame.params,
            frame.params.databaseId,
          );
        else
          options.report(frame.params.phase, {
            databaseId: frame.params.databaseId,
            migration: frame.params.migration,
          });
      } catch (error) {
        failure ??= error;
        terminate();
      }
    });
    onError((error) => {
      failure ??= error;
    });
    onExit((success) => {
      settled = true;
      clearTimeout(firstStateTimer);
      options.signal.removeEventListener("abort", abort);
      lines.close();
      if (success && prepared && !failure) {
        if (preparedPath) options.preparedPaths?.add(preparedPath);
        resolve();
      } else reject(failure ?? statusError("transport_closed"));
    });
    if (options.signal.aborted) abort();
  });
}
