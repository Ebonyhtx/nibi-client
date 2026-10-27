import { describe, expect, it, vi } from "vitest";
import type { ZCodeAgentMcpServer } from "@nibi/shared";
import { createCloudProjectMcpServerResolver } from "../src/cloud-project/cloudProjectMcpServerResolver.js";
import {
  CLOUD_PROJECT_BROKER_TOKEN_ENV,
  CLOUD_PROJECT_BROKER_URL_ENV,
  type CloudProjectBroker,
} from "../src/cloud-project/cloudProjectBroker.js";

function mathServer(): ZCodeAgentMcpServer {
  return {
    name: "plugin:math-modeling:math-modeling",
    command: "python",
    args: ["server.py"],
    env: [{ name: "NIBI_MATH_ENV_DIR", value: "/data/env" }],
  };
}

function otherServer(): ZCodeAgentMcpServer {
  return {
    name: "plugin:other:server",
    command: "node",
    args: ["server.js"],
    env: [{ name: "FOO", value: "bar" }],
  };
}

function fakeBroker(): CloudProjectBroker & { envForWorkspace: ReturnType<typeof vi.fn> } {
  return {
    envForWorkspace: vi.fn(async () => ({
      [CLOUD_PROJECT_BROKER_URL_ENV]: "http://127.0.0.1:12345",
      [CLOUD_PROJECT_BROKER_TOKEN_ENV]: "cap-token",
    })),
    dispose: vi.fn(async () => {}),
  } as never;
}

describe("cloudProjectMcpServerResolver", () => {
  it("只给数模插件 MCP server 注入 broker 能力，其他 server 不动", async () => {
    const broker = fakeBroker();
    const resolver = createCloudProjectMcpServerResolver({ broker });
    const servers = [mathServer(), otherServer()];
    const resolved = await resolver.resolveMcpServers(servers, { workspacePath: "/tmp/ws" });

    const math = resolved.find((server) => server.name === mathServer().name)!;
    const other = resolved.find((server) => server.name === otherServer().name)!;
    expect(math).not.toBe(servers[0]);
    expect(other).toBe(servers[1]);
    expect("env" in math ? math.env : []).toEqual(
      expect.arrayContaining([
        { name: "NIBI_MATH_ENV_DIR", value: "/data/env" },
        { name: CLOUD_PROJECT_BROKER_URL_ENV, value: "http://127.0.0.1:12345" },
        { name: CLOUD_PROJECT_BROKER_TOKEN_ENV, value: "cap-token" },
      ]),
    );
    expect(broker.envForWorkspace).toHaveBeenCalledWith("/tmp/ws");
    // 原数组不被就地修改（配置会被多处复用）。
    expect("env" in servers[0] ? servers[0].env : []).toHaveLength(1);
  });

  it("没有数模插件 server 时不签发令牌", async () => {
    const broker = fakeBroker();
    const resolver = createCloudProjectMcpServerResolver({ broker });
    const servers = [otherServer()];
    expect(await resolver.resolveMcpServers(servers, { workspacePath: "/tmp/ws" })).toBe(servers);
    expect(broker.envForWorkspace).not.toHaveBeenCalled();
  });

  it("broker 起不来时不阻断 agent spawn，只回调错误", async () => {
    const onError = vi.fn();
    const broker = fakeBroker();
    broker.envForWorkspace.mockRejectedValueOnce(new Error("listen EADDRINUSE"));
    const resolver = createCloudProjectMcpServerResolver({ broker, onError });
    const servers = [mathServer()];
    expect(await resolver.resolveMcpServers(servers, { workspacePath: "/tmp/ws" })).toBe(servers);
    expect(onError).toHaveBeenCalledWith(
      "cloud project broker unavailable during mcp resolve",
      expect.any(Error),
    );
  });
});
