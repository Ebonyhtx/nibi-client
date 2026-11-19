import { describe, expect, it } from "vitest";
import {
  V4_METHODS,
  v4SessionDataMeasureResultSchema,
  v4SessionDataParamsSchema,
  v4SessionDataPurgeResultSchema,
  v4SessionDeletionExecuteParamsSchema,
  v4SessionDeletionExecuteResultSchema,
  v4SessionDeletionPreviewParamsSchema,
  v4SessionDeletionPreviewResultSchema,
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

describe("v4 storage/sessionData 永久删除合同", () => {
  it("方法名与上游冻结值一致", () => {
    expect(V4_METHODS.sessionDeletionPreview).toBe("v4/storage/sessionData/deletionPreview");
    expect(V4_METHODS.sessionDeletionExecute).toBe("v4/storage/sessionData/deletionExecute");
  });

  it("preview/execute 入参严格，execute 另带 revision 与 operationId", () => {
    expect(
      v4SessionDeletionPreviewParamsSchema.parse({
        sessionId: "s1",
        workspace: { workspacePath: "/work/a", workspaceIdentity: "remote:ssh:a" },
      }),
    ).toEqual({
      sessionId: "s1",
      workspace: { workspacePath: "/work/a", workspaceIdentity: "remote:ssh:a" },
    });
    expect(
      v4SessionDeletionPreviewParamsSchema.safeParse({
        sessionId: "s1",
        workspace: { workspacePath: "/work/a" },
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      v4SessionDeletionPreviewParamsSchema.safeParse({
        sessionId: "",
        workspace: { workspacePath: "/work/a" },
      }).success,
    ).toBe(false);
    expect(
      v4SessionDeletionPreviewParamsSchema.safeParse({
        sessionId: "s1",
        workspace: { workspacePath: "/work/a", workspaceIdentity: null },
      }).success,
    ).toBe(false);
    expect(
      v4SessionDeletionExecuteParamsSchema.safeParse({
        sessionId: "s1",
        workspace: { workspacePath: "/work/a" },
        revision: "rev",
        operationId: "",
      }).success,
    ).toBe(false);
    expect(
      v4SessionDeletionExecuteParamsSchema.parse({
        sessionId: "s1",
        workspace: { workspacePath: "/work/a" },
        revision: "rev",
        operationId: "op",
      }),
    ).toEqual({
      sessionId: "s1",
      workspace: { workspacePath: "/work/a" },
      revision: "rev",
      operationId: "op",
    });
  });

  it("preview 结果带 blockedReason 与 incomplete/completed", () => {
    const result = {
      sessionId: "s1",
      revision: "r",
      sessionIds: ["s1", "child"],
      forks: [{ sessionId: "fork", title: "Fork" }],
      retainedArtifacts: [
        {
          sessionId: "s1",
          artifactId: "shared",
          fileName: "shared.png",
          referrers: [{ sessionId: "fork", title: "Fork" }],
        },
      ],
      deletedFiles: 2,
      blockedReason: "running" as const,
      incomplete: true,
      completed: false,
    };
    expect(v4SessionDeletionPreviewResultSchema.parse(result)).toEqual(result);
    expect(
      v4SessionDeletionPreviewResultSchema.safeParse({ ...result, blockedReason: "idle" }).success,
    ).toBe(false);
    expect(
      v4SessionDeletionPreviewResultSchema.safeParse({ ...result, deletedFiles: -1 }).success,
    ).toBe(false);
    expect(v4SessionDeletionPreviewResultSchema.safeParse({ ...result, extra: true }).success).toBe(
      false,
    );
  });

  it("execute 结果只允许 deleted/blocked/incomplete", () => {
    expect(
      v4SessionDeletionExecuteResultSchema.parse({
        sessionId: "s1",
        status: "blocked",
        sessionIds: ["s1"],
        retainedArtifacts: 1,
        reason: "changed",
      }),
    ).toEqual({
      sessionId: "s1",
      status: "blocked",
      sessionIds: ["s1"],
      retainedArtifacts: 1,
      reason: "changed",
    });
    expect(
      v4SessionDeletionExecuteResultSchema.safeParse({
        sessionId: "s1",
        status: "failed",
        sessionIds: [],
        retainedArtifacts: 0,
      }).success,
    ).toBe(false);
  });
});
