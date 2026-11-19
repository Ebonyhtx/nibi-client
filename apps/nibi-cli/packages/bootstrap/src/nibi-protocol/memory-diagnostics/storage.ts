import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  CLI_MEMORY_FILE_PATTERN,
  CLI_MEMORY_MAX_FILE_BYTES,
  CLI_MEMORY_MAX_FILES,
  CLI_MEMORY_MAX_TOTAL_BYTES,
  CLI_MEMORY_RETENTION_MS,
  sanitizeCliMemoryDiagnostic,
  type CliMemoryDiagnostic,
} from "@nibi/shared";
import { acquireFileLock, atomicWritePrivateTextFile } from "@nibi/shared/node";
import type { MemoryDiagnosticWriteResult } from "./types.js";

/** 锁竞争只做短暂尝试：诊断写盘永远不能排在业务写盘前面。 */
const LOCK_OWNERLESS_GRACE_MS = 100;
const LOCK_TRY_MS = 25;
/** 同一进程实例最多保留 2 个完成文件，让"当前现场"不被自己挤掉。 */
const MAX_FILES_PER_INSTANCE = 2;

let writing = false;

/**
 * 解析目标文件路径并确认它仍在诊断目录内。
 *
 * 文件名必须匹配固定 pattern（只含数字、UUID 与 `.jsonl`），
 * 因此 `..`、绝对路径、分隔符与 Windows 盘符都无法进入；
 * 这里再按 resolve 后的前缀复核一次，作为写盘前的最后一道门。
 */
export function resolveDiagnosticFilePath(directory: string, name: string): string | null {
  if (!CLI_MEMORY_FILE_PATTERN.test(name)) return null;
  const root = resolve(directory);
  const target = resolve(root, name);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return target.startsWith(prefix) ? target : null;
}

interface RetainedFile {
  path: string;
  name: string;
  size: number;
  mtime: number;
}

/**
 * 写入一条有界诊断记录。
 *
 * 预算与轮转（全部在目录锁内完成）：
 * - 每条记录先做白名单投影，序列化后超过 64 KiB 直接丢弃；
 * - 同一实例最多 2 个完成文件、全目录最多 16 个、合计不超过 1 MiB、超过 7 天淘汰；
 * - 先淘汰再原子替换；崩溃遗留的 `.memory-*.tmp` 由下一个持锁者回收；
 * - 同一进程内同时只允许一个写盘（模块级 `writing`），竞争失败只丢本轮。
 *
 * 任何失败都返回错误码而不是抛错：诊断写盘不能改变任务结果。
 */
export async function writeMemoryDiagnostic(
  directory: string,
  record: CliMemoryDiagnostic,
): Promise<MemoryDiagnosticWriteResult> {
  if (writing) return { ok: false, bytes: 0, error: "write_busy" };
  writing = true;
  let release: (() => Promise<void>) | undefined;
  try {
    const safe = sanitizeCliMemoryDiagnostic(record);
    if (!safe || !safe.instanceId) return { ok: false, bytes: 0, error: "sanitize_failed" };
    const text = `${JSON.stringify(safe)}\n`;
    const recordBytes = Buffer.byteLength(text);
    if (recordBytes > CLI_MEMORY_MAX_FILE_BYTES) {
      return { ok: false, bytes: 0, error: "record_too_large" };
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // 复用跨进程锁的存活 owner 判据；竞争只试一次，不创建进程内等待队列。
    release = await acquireFileLock(
      join(directory, "records"),
      [],
      LOCK_OWNERLESS_GRACE_MS,
      LOCK_TRY_MS,
    );

    const files: RetainedFile[] = [];
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      if (name.startsWith(".memory-") && name.endsWith(".tmp")) {
        await rm(path, { force: true });
        continue;
      }
      if (!CLI_MEMORY_FILE_PATTERN.test(name)) continue;
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > CLI_MEMORY_MAX_FILE_BYTES ||
        Date.now() - info.mtimeMs > CLI_MEMORY_RETENTION_MS
      ) {
        await rm(path, { force: true });
        continue;
      }
      files.push({ path, name, size: info.size, mtime: info.mtimeMs });
    }
    files.sort((a, b) => b.mtime - a.mtime);

    // 先替换本实例的旧记录，避免仍活跃的 CLI 很快挤掉已崩溃实例留下的最后现场。
    const retained: RetainedFile[] = [];
    let ownFiles = 0;
    for (const file of files) {
      if (file.name.endsWith(`-${safe.instanceId}.jsonl`)) {
        ownFiles += 1;
        if (ownFiles >= MAX_FILES_PER_INSTANCE) {
          await rm(file.path, { force: true });
          continue;
        }
      }
      retained.push(file);
    }
    const kept = retained.slice(0, CLI_MEMORY_MAX_FILES - 1);
    for (const old of retained.slice(CLI_MEMORY_MAX_FILES - 1)) {
      await rm(old.path, { force: true });
    }

    // 文件数上限已经隐含 1 MiB；这里再按字节预算显式淘汰最旧的，两者都不依赖对方。
    let keptBytes = kept.reduce((sum, file) => sum + file.size, 0);
    while (kept.length > 0 && keptBytes + recordBytes > CLI_MEMORY_MAX_TOTAL_BYTES) {
      const oldest = kept.pop();
      if (!oldest) break;
      keptBytes -= oldest.size;
      await rm(oldest.path, { force: true });
    }

    const filename = `memory-${Date.now()}-${safe.instanceId}.jsonl`;
    const target = resolveDiagnosticFilePath(directory, filename);
    if (!target) return { ok: false, bytes: keptBytes, error: "outside_directory" };
    await atomicWritePrivateTextFile(target, text, []);
    return { ok: true, bytes: keptBytes + recordBytes };
  } catch {
    // 存储不可用时丢本轮，不能阻塞或改变任务结果。
    return { ok: false, bytes: 0, error: "write_failed" };
  } finally {
    try {
      await release?.();
    } catch {
      // 下次使用既有 abandoned-lock 恢复。
    }
    writing = false;
  }
}
