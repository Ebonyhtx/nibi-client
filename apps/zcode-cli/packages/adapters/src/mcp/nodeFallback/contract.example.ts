/**
 * 标准调用：provider 首次 resolve 时准备 shim；把 binDir 与 env 交给 stdio MCP 的 spawn。
 */
import {
  applyMcpNodeFallbackEnv,
  createMcpNodeFallbackProvider,
  type McpNodeFallback,
} from "./contract.js";

export async function exampleAdaptersMcpNodeFallback(
  execPath: string,
  npmRootCandidates: readonly string[],
  storageRoot: string,
): Promise<Record<string, string>> {
  const provider = createMcpNodeFallbackProvider({
    execPath,
    npmRootCandidates,
    storageRoot,
  });
  const fallback: McpNodeFallback | undefined = await provider.resolve();
  return applyMcpNodeFallbackEnv({ PATH: "/usr/bin:/bin" }, fallback, "linux");
}
