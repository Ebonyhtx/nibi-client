/**
 * 宿主隔离：清掉从开发机终端继承来的代理变量。
 *
 * 为什么必须有这个文件：adapters 的 HTTP 用例用 `vi.stubGlobal("fetch", ...)` 拦住出站请求，
 * 但 `NodeHttpClientAdapter` 在检测到代理配置时会走自己的代理分支、绕过被 stub 的 fetch
 * —— 于是"发出去的请求"真的打到了外网（或本地代理），用例时绿时红。
 *
 * 只清代理键：其余环境（NIBI_* 数据根等）由各用例自己用 mkdtemp 隔离，不能在这里统一改，
 * 否则想验证环境解析的用例（exec / http）会失去输入。
 *
 * 该文件在 v4 基座上曾**只存在于 vitest 配置的引用里**（配置引用了 tests/setup-host-isolation.ts
 * 但文件从未入库），导致整个 adapters 包的用例在收集阶段就失败、一条都没跑过。
 */
const PROXY_KEYS = [
  "https_proxy",
  "HTTPS_PROXY",
  "http_proxy",
  "HTTP_PROXY",
  "all_proxy",
  "ALL_PROXY",
] as const;

for (const key of PROXY_KEYS) {
  delete process.env[key];
}
