import { open } from "node:fs/promises";
import { join } from "node:path";
import { getZCodeDataRootDir } from "#src/paths.js";

// 32 MiB 足以覆盖常规最近调用，同时避免 64/256 MiB 诊断文件造成 Host 内存峰值。
const MAX_TRAJECTORY_READ_BYTES = 32 * 1024 * 1024;

export interface TrajectoryFileTail {
  text: string;
  bytesRead: number;
  truncated: boolean;
}

// debug（开发态）与 rollout（生产态）都尝试，避免数据目录环境变量差异导致读不到。
//
// 根目录跟**数据根**走：dev / e2e 实例的 trajectory 写在它自己的数据根下，
// 写死主目录会去翻另一个实例的日志。没有环境变量时解析结果就是 `~/.nibi`，
// 与以前一致（所以这里不再手写一条主目录候选，免得又埋一个"跨实例读"的入口）。
export function resolveModelIODirs(): string[] {
  // 唯一数据根来源是 paths.ts（setDataBaseDir / NIBI_DATA_BASE_DIR / 主目录）。
  // 这里原来自己拼了一套 env + homedir：dev/e2e 注入的 setDataBaseDir 被绕过，
  // 测试与宿主切换数据根后读的仍是主目录那棵树的日志。
  const dataRoot = getZCodeDataRootDir();
  return ["debug", "rollout"].map((kind) => join(dataRoot, "cli", kind));
}

// 与 runner-debug.ts 的 sanitizeFileSegment 保持一致：仅保留文件名安全字符。
export function sanitizeSessionSegment(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export async function readTrajectoryFileTail(filePath: string): Promise<TrajectoryFileTail> {
  const handle = await open(filePath, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - MAX_TRAJECTORY_READ_BYTES);
    const length = size - start;
    const buffer = Buffer.allocUnsafe(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const result = await handle.read(buffer, bytesRead, length - bytesRead, start + bytesRead);
      if (result.bytesRead === 0) {
        break;
      }
      bytesRead += result.bytesRead;
    }

    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    return { text, bytesRead, truncated: start > 0 };
  } finally {
    await handle.close();
  }
}
