import { describe, expect, it, vi } from "vitest";
import {
  isNibiAgentSessionDataUnsupportedError,
  NIBI_AGENT_SESSION_DATA_UNSUPPORTED_ERROR_CODE,
} from "../src/nibi-agent/nibiAgentErrors.js";
import {
  requestSessionDataMeasure,
  requestSessionDataPurge,
} from "../src/nibi-agent/sessionDataRequest.js";

const params = {
  sessionIds: ["s1"],
  directories: [{ workspacePath: "/work" }],
};
const measureResult = { sessions: [{ sessionId: "s1", bytes: 4 }], memory: [] };
const purgeResult = {
  deleted: [{ sessionId: "s1", bytes: 4 }],
  kept: [],
  failed: [],
  memory: [],
};

describe("sessionData 请求边界", () => {
  it("measure 使用上游方法名并原样传参", async () => {
    const request = vi.fn().mockResolvedValue(measureResult);
    expect(await requestSessionDataMeasure({ request }, params)).toBe(measureResult);
    expect(request).toHaveBeenCalledWith(
      "v4/storage/sessionData/measure",
      params,
      expect.anything(),
    );
  });

  it("purge 使用上游方法名并原样传参", async () => {
    const request = vi.fn().mockResolvedValue(purgeResult);
    expect(await requestSessionDataPurge({ request }, params)).toBe(purgeResult);
    expect(request).toHaveBeenCalledWith("v4/storage/sessionData/purge", params, expect.anything());
  });

  it.each([
    ["measure", requestSessionDataMeasure],
    ["purge", requestSessionDataPurge],
  ] as const)("旧内核的 %s -32601 映射为稳定 unsupported", async (_name, call) => {
    const request = vi.fn().mockRejectedValue({ code: -32601 });
    const error = await call({ request }, params).catch((cause: unknown) => cause);
    expect(isNibiAgentSessionDataUnsupportedError(error)).toBe(true);
    expect((error as Error).message).toContain("does not support");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("只有 -32601 视为旧内核，其他错误原样上抛", async () => {
    for (const code of [-32602, -32000, undefined]) {
      const error = Object.assign(new Error("failed"), { code });
      const request = vi.fn().mockRejectedValue(error);
      await expect(requestSessionDataPurge({ request }, params)).rejects.toBe(error);
      expect(request).toHaveBeenCalledTimes(1);
    }
  });

  it("响应 schema 不合法时拒绝，不把半成品结果交给 Host", async () => {
    const request = vi.fn().mockImplementation(async (_method, _params, schema) =>
      schema.parse({
        deleted: [{ sessionId: "s1", bytes: -1 }],
        kept: [],
        failed: [],
        memory: [],
      }),
    );
    await expect(requestSessionDataPurge({ request }, params)).rejects.toThrow();
  });

  it("错误 code 是可跨 RPC 识别的稳定值", () => {
    expect(NIBI_AGENT_SESSION_DATA_UNSUPPORTED_ERROR_CODE).toBe(
      "NIBI_AGENT_SESSION_DATA_UNSUPPORTED",
    );
  });
});
