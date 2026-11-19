import {
  V4_METHODS,
  v4SessionDataMeasureResultSchema,
  v4SessionDataPurgeResultSchema,
  v4SessionDeletionExecuteResultSchema,
  v4SessionDeletionPreviewResultSchema,
  type V4SessionDataMeasureResult,
  type V4SessionDataParams,
  type V4SessionDataPurgeResult,
  type V4SessionDeletionExecuteParams,
  type V4SessionDeletionExecuteResult,
  type V4SessionDeletionPreviewParams,
  type V4SessionDeletionPreviewResult,
} from "@nibi/shared/nibi-protocol-v4";
import { NibiAgentSessionDataUnsupportedError } from "#src/nibi-agent/nibiAgentErrors.js";
import type { NibiProtocolClient } from "#src/nibi-agent/nibiProtocolClient.js";

/** 旧内核没有这个方法；只有 -32601 能证明是版本能力缺失，其它错误原样上抛。 */
function isProtocolMethodNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === -32601
  );
}

/**
 * `v4/storage/sessionData/measure|purge` 的请求边界：响应必须通过上游同形 schema，
 * 旧内核的 -32601 映射成稳定的 unsupported 错误，供 Host 隐藏清理入口。
 */
export async function requestSessionDataMeasure(
  client: Pick<NibiProtocolClient, "request">,
  params: V4SessionDataParams,
): Promise<V4SessionDataMeasureResult> {
  try {
    return await client.request(
      V4_METHODS.sessionDataMeasure,
      params,
      v4SessionDataMeasureResultSchema,
    );
  } catch (error) {
    if (isProtocolMethodNotFound(error)) throw new NibiAgentSessionDataUnsupportedError();
    throw error;
  }
}

export async function requestSessionDataPurge(
  client: Pick<NibiProtocolClient, "request">,
  params: V4SessionDataParams,
): Promise<V4SessionDataPurgeResult> {
  try {
    return await client.request(
      V4_METHODS.sessionDataPurge,
      params,
      v4SessionDataPurgeResultSchema,
    );
  } catch (error) {
    if (isProtocolMethodNotFound(error)) throw new NibiAgentSessionDataUnsupportedError();
    throw error;
  }
}

/** 归档会话永久删除的预检；旧内核同样按 -32601 映射为能力缺失。 */
export async function requestSessionDeletionPreview(
  client: Pick<NibiProtocolClient, "request">,
  params: V4SessionDeletionPreviewParams,
): Promise<V4SessionDeletionPreviewResult> {
  try {
    return await client.request(
      V4_METHODS.sessionDeletionPreview,
      params,
      v4SessionDeletionPreviewResultSchema,
    );
  } catch (error) {
    if (isProtocolMethodNotFound(error)) throw new NibiAgentSessionDataUnsupportedError();
    throw error;
  }
}

export async function requestSessionDeletionExecute(
  client: Pick<NibiProtocolClient, "request">,
  params: V4SessionDeletionExecuteParams,
): Promise<V4SessionDeletionExecuteResult> {
  try {
    return await client.request(
      V4_METHODS.sessionDeletionExecute,
      params,
      v4SessionDeletionExecuteResultSchema,
    );
  } catch (error) {
    if (isProtocolMethodNotFound(error)) throw new NibiAgentSessionDataUnsupportedError();
    throw error;
  }
}
