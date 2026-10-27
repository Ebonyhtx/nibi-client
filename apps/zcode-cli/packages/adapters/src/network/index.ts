// 出口层（对外入口）：**唯一的 proxy-aware fetch 工厂**。
//
// 为什么要有这个入口：Node 的 global fetch **不读** `HTTP_PROXY/http_proxy`（实测注释里的原话，
// 见 model-execution.ts）。模型请求与 MCP HTTP 传输早已改走这里，但"内置 provider 配置的远端
// 刷新"漏在外面用裸 fetch —— 在只有代理能出网的环境里（实测：`NIBI_HTTP_PROXY=http://127.0.0.1:7897`）
// 它必然 ECONNRESET，于是永远退回随包配置，还在每次解析模型时刷一行失败日志。
// 出口规则只应有这一份：新增任何"自己去要网络"的调用点，都从这里拿 fetch。

export {
  createNetworkProxyFetch,
  type NetworkProxyFetchOptions,
} from "./proxy-fetch.js";
