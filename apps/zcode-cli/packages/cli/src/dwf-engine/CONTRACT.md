# dwf-engine-sidecar

一页以内。只写类型与测试表达不了的三样：模块存在的意图、不变量、与其它模块的交集在哪个 hook 点处理。

## 意图

DWF 引擎侧车（路线 C）的 Node 宿主入口：`nibi.cjs __nibi-dwf-engine`。Rust 内核（与桌面
dev 的 Node 内核）按需把它作为子进程拉起，经 stdio 行协议驱动「引擎状态机 + 脚本 VM」，
自己只做裁决面的宿主。内核不重写引擎——这里承载 @nibi/core 的引擎与 harness（app-free，
只依赖 @nibi/dynamic-workflow 与 node 内建）。

## 线协议（内核 → 侧车为 request，侧车 → 内核为 notify）

- `initialize`（唯一 request）：返回能力侧启动参数；之后内核不再发请求，只收通知。
- `ask/start` / `ask/verdict` / `ask/cancel`：一次 ask 的派发、裁决回传与取消。
- `run/event`：run 级事件流——`hole-reached`（完整载荷：事件原文 + 编译期事实 + 展示元数据）、
  `run-stalled`（stall 载荷）、其余类型按 `{runId, type}` 透传。宿主据此组
  `<workflow-hole>` / `<workflow-stall>` 通知与开集转发。
- `run/settled`：结算通知（notice 事实 + settlement 袋；superseded 不发终态通知）。
- `workflows/list|get|save|updateMeta|delete|move|forRun`（request）：中枢读写面——解析器在
  @nibi/core（frontmatter/规则），这里只承载；`save|updateMeta|delete|move|forRun` 需要
  `dbPath` 指到会话库（与 holes/fill 同一家，读 journal）。
- `author/prepare` / `author/execute`（request）：作者工具的确认前/后两跳。prepare 跑
  `@nibi/core` 的 validateInput + resolveInput 并回 `{ok, input, gate}`；execute 跑同一份
  handler + formatModelContent 并回 `{ok, content, isError}`。入参带 `tool`/`input`/`cwd`/
  `session`/`toolCall`/`hasLoadedSkill`/`models`/`dbPath`——技能门与模型目录的事实由内核
  先算好，侧车不另开回宿主的 RPC。

## 不变量

- **写面没有降级**：没接侧车的宿主入口对写方法 fail-closed（读面的空页诚实，写面没有
  对应形状）；意外的 fs 失败收敛成结构化 `engine_error`，不让宿主悬等。
- **nonEmptyString 的 trim 是契约的一部分**（zod 转换）：拿名字拼文件名的路径必须照做，
  否则写出第二个名字。
- **进程是一次性的**：崩溃/退出即失效，内核侧下一次调用重新拉起；不尝试热恢复。
- 通知只投有界控制帧；大载荷（脚本正文）只在 request/response 里走。

## 与其它模块的交集

- 内核侧消费者：`kernel/crates/cli/src/dwf_engine_client.rs`（spawn/握手/转发）与
  `runtime` 的 `WorkflowEngine` 端口实现——本模块是它们的对端，字段改动必须两侧同批并过
  check-dwf-engine 门禁。
- 桌面 dev：`NIBI_DWF_ENGINE_CMD` 显式指到这里；打包态由桌面自带 Electron Node 跑
  `resources/glm/nibi.cjs __nibi-dwf-engine`（分发拍板 B）。
