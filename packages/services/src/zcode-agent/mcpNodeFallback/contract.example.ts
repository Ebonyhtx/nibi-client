import {
  buildMcpNodeFallbackHostEnv,
  type McpNodeFallbackHostEnvInput,
} from "./contract.js";

export function exampleServicesMcpNodeFallback(input: McpNodeFallbackHostEnvInput) {
  return buildMcpNodeFallbackHostEnv(input);
}
