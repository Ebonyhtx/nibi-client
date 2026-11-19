import { Session } from "node:inspector";
import type { AllocationNode, AllocationProfiler } from "./types.js";
import { MEMORY_SAMPLE_INTERVAL_BYTES } from "./recorder.js";

/** 栈深 16：够看清调用链，又不会让 profile 因深栈而膨胀。 */
const SAMPLING_STACK_DEPTH = 16;

/**
 * 进程内 inspector 分配采样器。
 *
 * 只在显式开启诊断时创建：不开放调试端口、不读源码、不生成 source map、
 * 不拍完整 heap snapshot、不主动 GC。`startSampling` 的采样间隔是 1 MiB。
 */
export function createAllocationProfiler(): AllocationProfiler {
  const session = new Session();
  const post = <T>(method: string, params: Record<string, unknown> = {}): Promise<T> =>
    new Promise((resolve, reject) =>
      session.post(method, params, (error, result) => (error ? reject(error) : resolve(result as T))),
    );
  const startSampling = () =>
    post<void>("HeapProfiler.startSampling", {
      samplingInterval: MEMORY_SAMPLE_INTERVAL_BYTES,
      stackDepth: SAMPLING_STACK_DEPTH,
      includeObjectsCollectedByMajorGC: false,
      includeObjectsCollectedByMinorGC: false,
    });
  return {
    async start() {
      session.connect();
      await startSampling();
    },
    async read() {
      const result = await post<{ profile: { head: AllocationNode } }>(
        "HeapProfiler.getSamplingProfile",
      );
      return result.profile;
    },
    async reset() {
      // disable 清除采样状态；不先 stopSampling 再复制一份完整 profile。
      await post("HeapProfiler.disable");
      await startSampling();
    },
    dispose() {
      session.disconnect();
    },
  };
}
