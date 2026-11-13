import { readFile, rename, writeFile } from "node:fs/promises";
import { serverStatusSchema, type ServerStatus } from "../contracts.js";
import { resolveServerLayout, type ServerLayout } from "./paths.js";

export type PersistedStatusRead =
  | { state: "valid"; status: ServerStatus }
  | { state: "missing"; status: null }
  | { state: "invalid" | "unreadable"; status: null; error: unknown };

export async function readPersistedStatusDetailed(layout: ServerLayout): Promise<PersistedStatusRead> {
  // Bug 原因：文件缺失表示离线，JSON/schema 损坏表示观测不可信；两者不能再折叠成同一个 null，
  // 否则 uninstall/stop 会把“无法确认已停止”误判成“已经停止”。
  let raw: string;
  try {
    raw = await readFile(layout.statusFile, "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { state: "missing", status: null };
    }
    return { state: "unreadable", status: null, error };
  }
  try {
    return { state: "valid", status: serverStatusSchema.parse(JSON.parse(raw)) };
  } catch (error: unknown) {
    return { state: "invalid", status: null, error };
  }
}

export async function readPersistedStatus(layout = resolveServerLayout()): Promise<ServerStatus | null> {
  return (await readPersistedStatusDetailed(layout)).status;
}

const RENAME_TRANSIENT_RETRIES = 10;
const RENAME_RETRY_DELAY_MS = 20;

function isTransientRenameError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  // Windows：目标文件被读取方持有（未带 FILE_SHARE_DELETE）时 MoveFileEx 返回
  // EPERM/EACCES/EBUSY。status.json 正被 waitForServerStopped 轮询读时，停止流程
  // 的 rename 会一直失败 → 快照停在旧状态、等待方超时。读取只持有文件几微秒，重试即可。
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
}

/** 原子替换，专治 Windows 上"读者短暂占用目标文件"导致的 rename 失败。 */
export async function replaceFileWithRetry(
  temporary: string,
  target: string,
  options: {
    rename?: typeof rename;
    retries?: number;
    delayMs?: number;
  } = {},
): Promise<void> {
  const renameFile = options.rename ?? rename;
  const retries = options.retries ?? RENAME_TRANSIENT_RETRIES;
  const delayMs = options.delayMs ?? RENAME_RETRY_DELAY_MS;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(temporary, target);
      return;
    } catch (error) {
      if (!isTransientRenameError(error) || attempt >= retries) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export function createStatusPersister<T>(
  statusFile: string,
  getStatus: () => T,
  onError: (error: unknown) => void,
): () => Promise<void> {
  let inFlight: Promise<void> = Promise.resolve();
  return async () => {
    // 一次 status 写盘失败不能让排队链永久 reject，否则后续生命周期快照
    // 会全部丢失；status.json 只是观测快照，失败时记录告警并继续服务生命周期。
    inFlight = inFlight
      .then(async () => {
        const temporary = `${statusFile}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(getStatus(), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await replaceFileWithRetry(temporary, statusFile);
      })
      .catch((error: unknown) => onError(error));
    await inFlight;
  };
}
