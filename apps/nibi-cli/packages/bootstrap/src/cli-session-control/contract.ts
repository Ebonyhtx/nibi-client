import type {
  MessageWithParts,
  SessionControlHost,
  SessionEvent,
  SessionInfo,
  SessionStorePort,
  TraceContext,
} from "@nibi/contracts";
import type { CliScope } from "@nibi/session-control/contracts";
import type { NibiApp } from "../app/types.js";

/** 新根的最小启动参数；不接受 actor mode、permission、parentSessionId 或 subagent 配置。 */
export interface NibiRootAppRequest {
  sessionId: string;
  cwd: string;
  model?: string;
  /** 只对本 manager 刚通过 stable fork 创建的全新 session 使用。 */
  resume: boolean;
  traceContext?: TraceContext;
}

export interface NibiSessionControlRuntimeOptions {
  /** 可信独立 CLI 启动范围；当前 adapter 不拥有跨进程 owner 路由。 */
  workspace: CliScope;
  sessionStore: SessionStorePort;
  /** 到达上限后拒绝新请求，不淘汰幂等回执后重放；默认 4096 requests / 128 roots。 */
  limits?: { requests?: number; roots?: number };
  /**
   * 读取时把持久消息投影为产品界面看到的 active 分支。由协议层注入，避免本模块
   * import 整个 server-operations（那会形成 ESM 循环）；缺席时按持久顺序返回。
   */
  projectActiveMessages?: (
    messages: MessageWithParts[],
    session: SessionInfo | null | undefined,
    rewindEvents: readonly SessionEvent[],
  ) => MessageWithParts[];
  /** 使用独立 CLI 配置创建 root app。不得展开 actor options 或继承其 yolo/批准。 */
  createRootApp(input: NibiRootAppRequest): Promise<NibiApp>;
}

export interface NibiSessionControlRuntime {
  /** 8 个动作 + 观察 feed/deadline 的窄宿主端口；工具层只经可信绑定访问。 */
  readonly control: SessionControlHost;
  /** 来源来自可信启动选项；borrowed 仅决定关闭责任，不决定目标读写权限。 */
  attachRoot(app: NibiApp, provenance: "new-independent-root" | "unverified-history"): void;
  /**
   * 调用方关闭 borrowed root 后摘除登记。旧 app 关闭后若仍留在 roots 表里，
   * 同 session 的冷恢复/restart 会被误判为「另一个 runtime 仍持有会话」。
   */
  releaseRoot(app: NibiApp): void;
  /** 先封闭准入，再中断、等待落盘并关闭本 manager 创建的 roots；borrowed root 由调用方关闭。 */
  close(): Promise<void>;
}
