import { ChannelClient, ChannelServer, createQueuePair, Emitter, ProxyChannel } from "@nibi/rpc";
import type { AgentLaneResourceSample } from "@nibi/shared";
import { describe, expect, it } from "vitest";
import { IZCodeAgentService } from "#src/zcode-agent/zcodeAgent.js";

describe("ZCode Agent resource telemetry RPC", () => {
  it("uses an explicit dynamic event across remote RPC without conversation state", async () => {
    const emitter = new Emitter<AgentLaneResourceSample>();
    const [serverProtocol, clientProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "test");
    const client = new ChannelClient(clientProtocol);
    server.registerChannel(
      IZCodeAgentService.channelName,
      ProxyChannel.fromService({
        onDynamicProcessResourceSample() {
          return emitter.event;
        },
      }),
    );
    const service = ProxyChannel.toService<IZCodeAgentService>(
      client.getChannel(IZCodeAgentService.channelName),
    );
    // lane 与 heap 等新字段必须原样穿过 RPC：远端 workspace 的样本靠这条链路回到 main。
    const sample: AgentLaneResourceSample = {
      arch: "x64",
      cpuCores: 2,
      cpuPercent: 25,
      heapUsedKb: 40_000,
      instanceToken: "9f2c4a1b7d0e5638",
      intervalMs: 60_000,
      lane: "chat",
      logicalCpuCount: 8,
      platform: "linux",
      rssKb: 128_000,
      totalMemoryGb: 32,
      uptimeMinutes: 7,
    };

    try {
      const received = new Promise<AgentLaneResourceSample>((resolve) => {
        service.onDynamicProcessResourceSample()(resolve);
      });
      // 动态事件的订阅要经队列对端注册；固定 20ms 在慢 runner 上会丢首帧（实测 Linux
      // CI 超时）。持续重发直到收到，收到即停，语义仍是"样本原样穿过 RPC"。
      const retry = setInterval(() => emitter.fire(sample), 10);
      try {
        await expect(received).resolves.toEqual(sample);
      } finally {
        clearInterval(retry);
      }
    } finally {
      client.dispose();
      server.dispose();
      emitter.dispose();
    }
  });
});
