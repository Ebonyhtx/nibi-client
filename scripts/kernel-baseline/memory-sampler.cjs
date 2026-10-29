/**
 * 子进程内存采样预加载（阶段 0 基线专用）。
 *
 * 通过 NODE_OPTIONS=--require 注入到被测进程；只读 process.memoryUsage() 与
 * v8.getHeapStatistics()，不修改堆上限、GC 策略或任何运行参数。采样结果按行写入
 * NIBI_BASELINE_SAMPLER_OUT，供 collect-kernel-baseline.mjs 汇总。
 */
"use strict";

const fs = require("node:fs");
const v8 = require("node:v8");
const { performance } = require("node:perf_hooks");

const outputPath = process.env.NIBI_BASELINE_SAMPLER_OUT?.trim();
if (outputPath) {
  const fd = fs.openSync(outputPath, "a");
  const startedAt = Date.now();
  const timeOrigin = performance.timeOrigin;

  const write = (tag) => {
    const memory = process.memoryUsage();
    const heap = v8.getHeapStatistics();
    const cpu = process.cpuUsage();
    const record = {
      tag,
      at: Date.now(),
      sinceProcessStartMs: Math.round(performance.now()),
      timeOrigin,
      pid: process.pid,
      rss: memory.rss,
      heapTotal: memory.heapTotal,
      heapUsed: memory.heapUsed,
      external: memory.external,
      arrayBuffers: memory.arrayBuffers,
      heapSizeLimit: heap.heap_size_limit,
      totalAvailableSize: heap.total_available_size,
      mallocedMemory: heap.malloced_memory,
      peakMallocedMemory: heap.peak_malloced_memory,
      nativeContexts: heap.number_of_native_contexts,
      detachedContexts: heap.number_of_detached_contexts,
      userCpuUs: cpu.user,
      systemCpuUs: cpu.system,
    };
    try {
      fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    } catch {
      // 采样写失败不能影响被测进程。
    }
  };

  write("start");
  const timer = setInterval(() => write("sample"), 250);
  timer.unref?.();
  process.on("exit", () => {
    clearInterval(timer);
    write("exit");
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  });

  // 保留 startedAt 供以后扩展按时间窗口切片。
  void startedAt;
}
