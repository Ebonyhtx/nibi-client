import type { SourceServerContract } from "./contract.js";

/**
 * 一次远端连接失败的最小用法：归一化 → 按 `code` 判日志级别。
 * 调用方拿到的是稳定 code，不再自己解析错误文本。
 */
export function exampleReportRemoteConnectionFailure(
  contract: SourceServerContract,
  error: unknown,
): { code: string; level: "info" | "error" } {
  const failure = contract.normalizeFailure(error);
  return { code: failure.code, level: contract.failureLogLevel(failure.code) };
}
