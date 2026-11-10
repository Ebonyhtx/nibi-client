import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@nibi/contracts";
import type { NibiProtocolNotification } from "@nibi/shared";
import { NIBI_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS } from "../../src/process-resource-sampler.js";
import { startProtocolResourceSampler } from "../../src/nibi-protocol/resource-sampler.js";
import type { NibiProtocolAgentServer } from "../../src/nibi-protocol/server.js";

function stubServer() {
  return {
    collectMemoryDiagnostics: vi.fn(() => ({ sessions: 0 })),
    pruneDetachedChildPublishers: vi.fn(() => 0),
    pruneSessionEventStores: vi.fn(() => 0),
    rebalanceResidentSessions: vi.fn(),
  };
}

function stubLogger(): Logger {
  const logger = {
    child: () => logger,
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
  return logger as unknown as Logger;
}

describe("protocol resource sampler fallback", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("60s 采样节拍兜底触发 resident 收敛、event store 淘汰与 detached publisher 清理", () => {
    vi.useFakeTimers();
    // sampler.start 先取一次基线，第一个 60s tick 才能算出 elapsed；为 CPU/hrtime 注入
    // 确定读数，避免 fake timers 下真实单调时钟不前进导致样本被丢弃。
    vi.spyOn(process, "cpuUsage")
      .mockReturnValueOnce({ system: 0, user: 0 })
      .mockReturnValue({ system: 10_000_000, user: 50_000_000 });
    vi.spyOn(process.hrtime, "bigint").mockReturnValueOnce(0n).mockReturnValue(60_000_000_000n);

    const server = stubServer();
    const send = vi.fn<(message: NibiProtocolNotification) => void>();
    const sampler = startProtocolResourceSampler(
      server as unknown as NibiProtocolAgentServer,
      send,
      stubLogger(),
    );
    expect(sampler).toBeDefined();
    expect(NIBI_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS).toBe(60_000);

    vi.advanceTimersByTime(NIBI_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS);

    expect(server.rebalanceResidentSessions).toHaveBeenCalledTimes(1);
    expect(server.pruneSessionEventStores).toHaveBeenCalledTimes(1);
    expect(server.pruneDetachedChildPublishers).toHaveBeenCalledTimes(1);
    expect(server.collectMemoryDiagnostics).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);

    sampler?.stop();
  });

  it("兜底淘汰抛错不会阻断同一节拍的资源上报", () => {
    vi.useFakeTimers();
    vi.spyOn(process, "cpuUsage")
      .mockReturnValueOnce({ system: 0, user: 0 })
      .mockReturnValue({ system: 10_000_000, user: 50_000_000 });
    vi.spyOn(process.hrtime, "bigint").mockReturnValueOnce(0n).mockReturnValue(60_000_000_000n);

    const server = stubServer();
    server.pruneSessionEventStores.mockImplementation(() => {
      throw new Error("prune failed");
    });
    const send = vi.fn<(message: NibiProtocolNotification) => void>();
    const sampler = startProtocolResourceSampler(
      server as unknown as NibiProtocolAgentServer,
      send,
      stubLogger(),
    );

    vi.advanceTimersByTime(NIBI_PROCESS_RESOURCE_SAMPLE_INTERVAL_MS);

    expect(server.rebalanceResidentSessions).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);

    sampler?.stop();
  });
});
