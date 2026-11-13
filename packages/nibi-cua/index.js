/**
 * 包根入口：没有 broker 端点时保持"不可用、失败干净"（dev/正式版未接引擎时的默认态）；
 * 有端点时走真运行时（见 ./runtime/index.js）。
 */
import { createComputerUseRuntime as createRealRuntime } from "./runtime/index.js";

const UNAVAILABLE_TEXT = "Computer Use is not available in this build.";

export function createComputerUseRuntime(options) {
  const socketPath =
    typeof options?.brokerSocketPath === "string" ? options.brokerSocketPath.trim() : "";
  if (!socketPath) {
    return {
      async execute() {
        return { content: [{ type: "text", text: UNAVAILABLE_TEXT }], isError: true };
      },
      async closeSession() {},
      async dispose() {},
    };
  }
  return createRealRuntime(options);
}
