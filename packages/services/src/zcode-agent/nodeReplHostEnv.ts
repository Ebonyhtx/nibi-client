/**
 * Rust 内核没有 Node bootstrap：Browser Use / Computer Use 共用的 `node_repl` MCP 服务器由内核
 * 自己装配（`kernel/crates/runtime/src/node_repl.rs`）。Host 只传 Node 可执行路径与“已提供执行面”
 * 的标记；Node 内核不读这两个变量。
 *
 * 这两个键名是与 Rust 选择器的唯一契约：`NIBI_HOST_NODE_REPL=1` 才会放行
 * `node-repl-host` / `computer-use` 的插件 skill。
 */
export type NodeReplKernelSelection = "node" | "rust";

export function buildNodeReplHostEnv(input: {
  kernel: NodeReplKernelSelection;
  execPath: string;
}): Record<string, string> {
  if (input.kernel !== "rust") return {};
  return {
    NIBI_HOST_NODE_REPL: "1",
    NIBI_NODE_EXEC_PATH: input.execPath,
  };
}
