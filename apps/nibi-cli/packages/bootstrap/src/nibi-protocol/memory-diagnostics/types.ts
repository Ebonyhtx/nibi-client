import type {
  CliMemoryDiagnostic,
  CliMemoryDiagnosticCounters,
  CliMemoryReading,
} from "@nibi/shared";

/** V8 分配采样 profile 的节点；只投影已知发布 bundle 的位置。 */
export interface AllocationNode {
  id: number;
  selfSize: number;
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  children: AllocationNode[];
}

export interface AllocationProfiler {
  start(): Promise<void>;
  read(): Promise<{ head: AllocationNode }>;
  reset(): Promise<void>;
  dispose(): void;
}

export interface MemoryDiagnosticRecorder {
  start(): Promise<void>;
  sample(): Promise<void>;
  stop(): void;
  /** 健康度计数器快照；不包含任何记录内容。 */
  getCounters(): CliMemoryDiagnosticCounters;
}

/** 写盘结果：`bytes` 是写完后诊断目录内完成文件的总字节数。 */
export interface MemoryDiagnosticWriteResult {
  ok: boolean;
  bytes: number;
  /** 失败时是短错误码（不含路径与消息），成功时省略。 */
  error?: string;
}

export interface MemoryDiagnosticOptions {
  /** 发布 bundle 的绝对路径；只有命中它的栈帧才会被记录。 */
  bundlePath: string;
  metadata(): Pick<
    CliMemoryDiagnostic,
    "instanceId" | "pid" | "version" | "commit" | "node" | "v8" | "bundleSha256"
  >;
  profiler: AllocationProfiler;
  readMemory(): Omit<CliMemoryReading, "at" | "counters">;
  readCounters(): Record<string, number>;
  write(record: CliMemoryDiagnostic): Promise<MemoryDiagnosticWriteResult>;
  now?(): number;
  measure?(): number;
}
