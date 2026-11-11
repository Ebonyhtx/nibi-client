import { describe, expect, it } from "vitest";
import {
  V4_METHODS,
  v4SessionDataMeasureResultSchema,
  v4SessionDataParamsSchema,
  v4SessionDataPurgeResultSchema,
} from "../src/nibi-protocol-v4/index.js";

describe("v4 storage/sessionData 合同", () => {
  it("方法名与上游冻结值一致", () => {
    expect(V4_METHODS.sessionDataMeasure).toBe("v4/storage/sessionData/measure");
    expect(V4_METHODS.sessionDataPurge).toBe("v4/storage/sessionData/purge");
  });

  it("入参只接受 sessionIds 与 directories，目录身份可省略", () => {
    expect(
      v4SessionDataParamsSchema.parse({
        sessionIds: ["s1", "s2"],
        directories: [
          { workspacePath: "/work/a" },
          { workspacePath: "/work/b", workspaceIdentity: "remote:ssh:b" },
        ],
      }),
    ).toEqual({
      sessionIds: ["s1", "s2"],
      directories: [
        { workspacePath: "/work/a" },
        { workspacePath: "/work/b", workspaceIdentity: "remote:ssh:b" },
      ],
    });
    expect(
      v4SessionDataParamsSchema.safeParse({
        sessionIds: ["s1"],
        directories: [],
        extra: true,
      }).success,
    ).toBe(false);
    expect(v4SessionDataParamsSchema.safeParse({ sessionIds: [""], directories: [] }).success).toBe(
      false,
    );
    expect(
      v4SessionDataParamsSchema.safeParse({
        sessionIds: [],
        directories: [{ workspacePath: "/work", workspaceIdentity: "" }],
      }).success,
    ).toBe(false);
  });

  it("measure 结果区分会话文件与项目记忆，拒绝负数与非整数", () => {
    expect(
      v4SessionDataMeasureResultSchema.parse({
        sessions: [{ sessionId: "s1", bytes: 2048 }],
        memory: [{ workspacePath: "/work", bytes: 0 }],
      }),
    ).toEqual({
      sessions: [{ sessionId: "s1", bytes: 2048 }],
      memory: [{ workspacePath: "/work", bytes: 0 }],
    });
    expect(
      v4SessionDataMeasureResultSchema.safeParse({
        sessions: [{ sessionId: "s1", bytes: -1 }],
        memory: [],
      }).success,
    ).toBe(false);
    expect(
      v4SessionDataMeasureResultSchema.safeParse({
        sessions: [{ sessionId: "s1", bytes: 1.5 }],
        memory: [],
      }).success,
    ).toBe(false);
    expect(
      v4SessionDataMeasureResultSchema.safeParse({
        sessions: [],
        memory: [],
        extra: true,
      }).success,
    ).toBe(false);
  });

  it("purge 结果保留 running/referenced 原因与可重试的失败项", () => {
    const result = {
      deleted: [{ sessionId: "gone", bytes: 10 }],
      kept: [
        { sessionId: "running", reason: "running" as const },
        { sessionId: "referenced", reason: "referenced" as const },
      ],
      failed: [
        { sessionId: "denied", code: "storage.permission" },
        { workspacePath: "/work", code: "storage.permission" },
      ],
      memory: [{ workspacePath: "/work", bytes: 5 }],
    };
    expect(v4SessionDataPurgeResultSchema.parse(result)).toEqual(result);
    expect(
      v4SessionDataPurgeResultSchema.safeParse({
        ...result,
        kept: [{ sessionId: "other", reason: "idle" }],
      }).success,
    ).toBe(false);
    expect(
      v4SessionDataPurgeResultSchema.safeParse({
        ...result,
        failed: [{ code: "" }],
      }).success,
    ).toBe(false);
    expect(
      v4SessionDataPurgeResultSchema.safeParse({ ...result, deleted: [], extra: true }).success,
    ).toBe(false);
  });

  it("序列化保持 camelCase 与可选字段缺席", () => {
    const serialized = JSON.parse(
      JSON.stringify(
        v4SessionDataPurgeResultSchema.parse({
          deleted: [],
          kept: [{ sessionId: "s", reason: "referenced" }],
          failed: [{ code: "io" }],
          memory: [],
        }),
      ),
    );
    expect(serialized).toEqual({
      deleted: [],
      kept: [{ sessionId: "s", reason: "referenced" }],
      failed: [{ code: "io" }],
      memory: [],
    });
  });
});
