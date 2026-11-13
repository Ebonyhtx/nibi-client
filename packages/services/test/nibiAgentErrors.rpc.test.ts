import { ChannelClient, ChannelServer, createQueuePair, ProxyChannel } from "@nibi/rpc";
import { describe, expect, it } from "vitest";
import { INibiAgentService } from "#src/nibi-agent/nibiAgent.js";
import {
  NIBI_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE,
  NibiAgentMcpStatusModeUnsupportedError,
} from "#src/nibi-agent/nibiAgentErrors.js";

describe("Nibi Agent RPC errors", () => {
  it("preserves the MCP status-only unsupported code across ChannelClient RPC", async () => {
    const [serverProtocol, clientProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "test");
    const client = new ChannelClient(clientProtocol);
    server.registerChannel(
      INibiAgentService.channelName,
      ProxyChannel.fromService({
        async listMcpServerStatuses() {
          throw new NibiAgentMcpStatusModeUnsupportedError();
        },
      }),
    );
    const service = ProxyChannel.toService<INibiAgentService>(
      client.getChannel(INibiAgentService.channelName),
    );

    try {
      await expect(
        service.listMcpServerStatuses({
          mcpServers: [],
          mode: "status",
          workspacePath: "/tmp/workspace",
        }),
      ).rejects.toMatchObject({
        code: NIBI_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE,
        name: "NibiAgentMcpStatusModeUnsupportedError",
      });
    } finally {
      client.dispose();
      server.dispose();
    }
  });
});
