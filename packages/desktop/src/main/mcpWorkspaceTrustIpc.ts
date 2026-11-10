/**
 * 工作区 MCP 信任的 Desktop IPC 入口。
 *
 * 只接受「用户对一条当前声明」的决定；renderer 不能直接写信任存储。Host 重新读取项目
 * 声明并核对精确摘要，未登记窗口 / 离线 / 损坏存储一律返回 shared 的 reasonCode。
 */

import type { WorkspaceMcpTrustDecision } from "@nibi/shared";
import {
  createWorkspaceMcpTrustRegistry,
  decideWorkspaceMcpTrust,
  isWorkspaceRegisteredForMcpInspection,
} from "./mcpWorkspaceTrust/index.js";
import { loadCliMcpFromUserDirectory } from "./mcpUserDirectory/index.js";
import type { WorkspaceMcpTrustDecisionRequest } from "../shared/workspaceMcpTrustBridge.js";
import type { WorkspaceMcpTrustLoadResult } from "./mcpWorkspaceTrust/contract.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 严格解析 renderer payload；形状不对不读取任何项目文件。 */
export function parseWorkspaceMcpTrustDecisionRequest(
  payload: unknown,
): WorkspaceMcpTrustDecisionRequest | null {
  if (!isRecord(payload)) return null;
  if (!nonEmptyString(payload.workspacePath)) return null;
  if (!nonEmptyString(payload.serverName)) return null;
  if (!nonEmptyString(payload.declarationDigest)) return null;
  if (typeof payload.trusted !== "boolean") return null;
  if (payload.workspaceIdentity !== undefined && typeof payload.workspaceIdentity !== "string") {
    return null;
  }
  return {
    workspacePath: payload.workspacePath,
    ...(typeof payload.workspaceIdentity === "string" && payload.workspaceIdentity.trim()
      ? { workspaceIdentity: payload.workspaceIdentity.trim() }
      : {}),
    serverName: payload.serverName,
    declarationDigest: payload.declarationDigest,
    trusted: payload.trusted,
  };
}

export interface WorkspaceMcpTrustDecisionIpcInput {
  /** 本窗口真正打开过的 workspace（BrowserWindow.id → paths）。 */
  windowWorkspaceMap: ReadonlyMap<number, ReadonlySet<string>>;
  windowId: number | undefined;
  payload: unknown;
  /** 测试注入；生产走真实目录读取。 */
  loadRecords?: typeof loadCliMcpFromUserDirectory;
}

/**
 * 处理一次显式信任/撤销。成功只代表本次决定被接受；调用方必须重新读取 Host 的 review，
 * 不能把 renderer 传回的 digest 当作已信任状态。
 */
export async function decideWorkspaceMcpTrustForWindow(
  input: WorkspaceMcpTrustDecisionIpcInput,
): Promise<WorkspaceMcpTrustDecision> {
  const request = parseWorkspaceMcpTrustDecisionRequest(input.payload);
  if (!request) {
    return { accepted: false, reasonCode: "workspace_mcp_trust_unavailable" };
  }
  if (
    !isWorkspaceRegisteredForMcpInspection(
      input.windowWorkspaceMap,
      input.windowId,
      request.workspacePath,
    )
  ) {
    return { accepted: false, reasonCode: "workspace_mcp_workspace_not_registered" };
  }

  const registeredWorkspaces = createWorkspaceMcpTrustRegistry();
  registeredWorkspaces.register({
    workspacePath: request.workspacePath,
    ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
    online: true,
  });

  let loaded: WorkspaceMcpTrustLoadResult;
  try {
    loaded = await (input.loadRecords ?? loadCliMcpFromUserDirectory)(
      {
        workspacePath: request.workspacePath,
        ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
      },
      { workspaceRegistered: true },
    );
  } catch {
    return { accepted: false, reasonCode: "workspace_mcp_trust_unavailable" };
  }

  // 工作区在读取阶段被 Host 判为离线时不写记录（未来远端窗口登记接入后同样 fail closed）。
  if (loaded.trustReasonCode === "workspace_mcp_workspace_offline") {
    return { accepted: false, reasonCode: "workspace_mcp_workspace_offline" };
  }

  return decideWorkspaceMcpTrust({
    records: loaded.servers,
    workspacePath: request.workspacePath,
    ...(request.workspaceIdentity ? { workspaceIdentity: request.workspaceIdentity } : {}),
    serverName: request.serverName,
    declarationDigest: request.declarationDigest,
    trusted: request.trusted,
    registeredWorkspaces,
  });
}
