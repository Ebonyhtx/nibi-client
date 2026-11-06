/**
 * source-server 的对外契约：远程目标（SSH / WSL / Docker）的版本兼容性判定、
 * 连接失败归一化，以及所有用户可见连接日志的脱敏边界。
 *
 * 只描述**行为面**；schema 与类型继续由 contracts.ts / compatibility.ts 提供——
 * 在这里重写一份定义只会制造两份会漂移的真相。`contract.test.ts` 把实现与这份契约
 * 逐项对齐，实现改名或改签名时会先红。
 */
import type { CompatibilityManifest, SourceServerCompatibilityResult } from "./compatibility.js";
import type { RemoteConnectionFailure } from "./connectionErrors.js";

export interface SourceServerContract {
  /** 当前构建的兼容性清单；远端上报的那份与它判定。 */
  manifest: CompatibilityManifest;
  /** 比较两侧产品版本，>0 表示控制端更新。 */
  compareVersions: typeof import("./compatibility.js").compareCompatibilityVersions;
  /** 判定控制端与远端能否互通、以及谁该升级。 */
  evaluateCompatibility: typeof import("./compatibility.js").evaluateSourceServerCompatibility;
  /** 把任意连接异常归一成可展示、可判级的失败种类。 */
  normalizeFailure: typeof import("./connectionErrors.js").normalizeRemoteConnectionError;
  /** 用户可见连接日志的脱敏边界（主机、路径、凭据、ANSI 控制序列）。 */
  sanitizeLog: typeof import("./connectionLog.js").sanitizeRemoteConnectionLog;
  /** 按失败原因决定日志级别：被用户取消/未安装属正常流程，其余记 error。 */
  failureLogLevel: typeof import("./connectionLog.js").remoteConnectionFailureLogLevel;
}

/** 归一化后的连接失败；`code` 是给 UI 判级与文案的稳定标识。 */
export type SourceServerFailure = RemoteConnectionFailure;

/** 兼容性判定结果：谁更新、是否需要升级、最低版本是多少。 */
export type SourceServerCompatibility = SourceServerCompatibilityResult;
