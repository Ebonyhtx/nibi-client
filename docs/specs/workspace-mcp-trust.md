# Workspace MCP 手动信任（A5/A6）

> 上游语义：`apps/zcode-cli/packages/bootstrap/src/workspace-mcp-trust/`（ZCode 3.17.2）。
> 本规格描述 NIBI 的落地边界：项目级 MCP 声明按内容摘要逐条信任，Host 是唯一写入者，
> Rust 内核只读取同一份用户域记录。

| 字段       | 值                                                               |
| ---------- | ---------------------------------------------------------------- |
| 状态       | 已实施（Host 存储/准入 + Rust 只读准入；设置页行内审核、会话内提示、远端 trust 回传/决定已接线） |
| 日期       | 2026-11-11                                                       |
| 适用范围   | Desktop Host（`packages/desktop/src/main/mcpUserDirectory`）、services（`mcp-trust`）、Rust CLI/ext |
| 安全基线   | 默认拒绝、显式授权、声明变化按条失效、损坏/离线 fail-closed       |
| 唯一 owner | 每个 Environment 的 Host（`mcp-trust`）；内核不写该文件           |

## 1. 目标与不变量

1. `.nibi/config.json`（以及 `.agents/mcp.json` fallback）里的**项目级** MCP 声明，在用户
   显式审核前一律不装载、不连接、不发起子进程/HTTP 请求。
2. 信任以**声明内容摘要**（SHA-256）为键：配置的 command/args/env/cwd、URL/headers、OAuth、
   `protocolVersion`、`alwaysLoad`、`timeoutMs` 任一执行相关字段变化，原授权立即失效。
3. `enabled` 与信任正交：停用不会被当成撤销，启用也不会扩大或清除授权。
4. 用户级 MCP、插件 MCP、内建 MCP 不属于本项目审核范围，保持原行为。
5. 同名 server 不跨 `workspaceIdentity` 继承授权。
6. 存储缺失 = 没有授权（尚未审核）；存储损坏/不可读 = 全部拒绝，且不覆盖损坏文件。
7. 离线/未注册的工作区不读项目声明、不复用旧授权（fail closed）。

## 2. 存储

- 位置：`<存储根>/security/workspace-mcp-trust-v1.json`，与 hooks 信任记录同一目录、同一
  存储根解析规则（用户级配置 `storage.dir`；`~/` 展开到 home，相对路径相对 home；缺省
  `~/.nibi`）。项目目录不能指定该文件位置。
- 写入：Host 唯一 owner，走 `updateJsonObjectFile`（严格读取、写前重读、临时文件 + rename、
  0600）。只写本文件自己的 `schemaVersion` / `records`，不改 `config.json`。
- 读取：Host 与 Rust 都按同一 strict schema 解析；JSON 语法错误、未知版本、缺字段、多余的键、
  重复的 `(workspaceIdentity, serverName, declarationDigest)` 都判 corrupt，整份作废。
- Rust 只读，不加锁、不改名损坏文件、不写入。

```json
{
  "schemaVersion": 1,
  "records": [
    {
      "workspaceIdentity": "/path/to/workspace",
      "serverName": "probe",
      "declarationDigest": "<64 位小写十六进制 sha256>",
      "grantedAt": "2026-11-11T00:00:00.000Z"
    }
  ]
}
```

## 3. 声明摘要（v1）

对每条项目声明计算：

```text
sha256( canonicalJson({
  version: 1,
  workspaceIdentity: <identity>,
  serverName: <name>,
  config: <归一化后的执行配置>
}) )
```

`config` 字段只保留执行相关字段，并按 UTF-16 码元排序（Host 与 Rust 一致）：

- 通用：`alwaysLoad`（缺省 false）、`oauth`（缺省 null）、`protocolVersion`（`auto` /
  `legacy` / `2026-07-28`，缺省 `auto`）、`timeoutMs`（正整数向上取整，缺省 null）、`type`。
- `stdio`：`command`、`args`（字符串数组，缺省 `[]`）、`env`（字符串 map，键排序）、
  `cwd`（非空字符串或 null，原样保留相对/绝对）。
- `http` / `sse`：`url`、`headers`（字符串 map，键排序）。

归一化与 Node/Rust 配置入口一致：`environment -> env`、`type: "remote" -> "http"`、
`http_headers -> headers`；`enabled` / `enable` / `timeout` / `startup_timeout_sec` 不参与摘要。
`source`、`machine` 与展示字段不参与摘要。无法归一化的声明不进入审核列表（保持拒绝）。

`workspaceIdentity` 统一为 `workspaceIdentity?.trim() || workspacePath`。

## 4. 准入

### 4.1 Host

```text
工作区打开/登记 → 读取项目声明 + 用户域记录 → 逐条 review（digest/来源/脱敏展示）
设置决定 → 重读当前声明并核对精确 digest → 原子写记录
Agent 装载 → 过滤掉未信任的项目 MCP（用户/插件不受影响）
```

`inspect`/`decide`/`admit` 只对**已注册工作区**生效（A6）：

- 未注册路径：不读项目配置，返回空 review；
- 已注册但 `online === false`（远端离线/连接不可用）：返回空 review，`decide` 返回
  `workspace_mcp_workspace_offline`，不写记录；
- 只有本窗口打开过的工作区（`windowWorkspaceMap`）才允许 `loadMcpFromUserDirectory` 读取项目
  配置；未登记时只返回用户级 MCP。
- UI store（`getEnabledMcpServersForZCode`）只把 `trust[server].trusted === true` 的项目 MCP
  放进 Agent 输入；编辑项目声明会立即清除该行缓存，必须重新审核。旧远端 Host 的目录结果没有
  `trust` 字段时保持兼容（`workspaceTrustKnown=false`，不按未知状态批量停用项目 MCP）；本机
  Host 与新远端 Host 一律按 fail-closed 过滤。

评审展示只包含脱敏内容：stdio 显示 command/args/cwd 与环境变量**名字**；HTTP/SSE 去掉
URL userinfo/query/hash，只显示 header 名字与 OAuth 类型。命令参数中的常见密钥
（`--token`、`--api-key`、`--secret`、`--password`、`Bearer` 等）替换为 `***`。

### 4.2 Rust

- 入口（`crates/cli`）把项目服务器按同一算法算出 digest，读取同一份信任文件，构造
  `ProjectMcpTrust { declared: name -> digest, trusted: digests, corrupt }` 注入
  `McpSettings.project_trust`。
- `crates/ext` 的 `McpManager::start/reconcile` 只装载 `McpScope::Project` 中 digest 命中
  记录（且工作区身份一致）的服务器；其余跳过，记录
  `mcp.project_trust.rejected` 诊断（`workspace_mcp_pending_trust` /
  `workspace_mcp_declaration_changed` / `workspace_mcp_trust_store_corrupt`）。
- 未注入信任快照（库的默认构造）不启用强制模式，仅用于非 Host 嵌入与既有单测；CLI 入口总是
  注入并启用。
- 会话级/`--mcp-config`/插件服务器是 `Dynamic`/`Plugin`/`User` 作用域，不经过本闸门；
  Host 在把项目服务器下发给会话前已按同一记录过滤。

### 4.3 远端工作区

- `IMcpSyncService.loadMcpFromUserDirectory` 在既有方法内回传 `trust` / `unreviewable`；
  远端 Host 使用同一份 `mcp-trust` 实现，信任库与声明都在该 Environment 的文件系统上。
- `IMcpSyncService.decideWorkspaceMcpTrust`（可选方法）接受远端 UI 的信任/撤销；旧远端 Host
  没有该方法时 UI 按 `workspace_mcp_trust_unavailable` 处理，不回退到本机 Host 的信任库。
- 会话内提示条（`WorkspaceMcpTrustPendingBanner`）从已绑定的 MCP store 读取 Host review，
  展示被跳过的项目 MCP 数量并提供「去审核」入口；旧 Host 无 trust 元数据时不误报。

### 4.4 会话内提示

项目 MCP 未信任时 Host/UI 过滤 + Rust 跳过，二者都不连接；会话底部常驻提示条把这一静默
跳过变成用户可见原因，并跳转设置页 MCP 分区。提示条只显示计数，不展示原始配置（脱敏摘要
仍在设置页行内）。

## 5. 失效与生命周期

- 信任只覆盖声明，不覆盖脚本/二进制/依赖包/远端服务的供应链。
- 撤销、配置删除/修改、存储损坏在**下一次连接准入**生效；已建立的连接按原生命周期释放，
  不回滚已提交副作用。
- 显式断开/关闭立即禁止后续调用。
- 设置页刷新只更新状态，不自动连接；信任后由用户刷新或下一次会话启动触发连接。

## 6. 验收

- 未信任项目 MCP 不装载（Host 过滤 + Rust 跳过，零进程/零 HTTP 请求）。
- 声明 digest 变化后旧授权失效，`decide` 拒绝旧 digest。
- 存储损坏、读取失败、离线/未注册工作区全部 fail closed。
- 已注册工作区过滤：未登记路径不读项目配置、不返回 review。
- Host 写入原子且只改信任文件自己的字段；其他工作区/服务器记录保留；配置文件字节不变。
- 相关 vitest（desktop/services）与 `cargo test -p nibi-kernel-ext` 通过。

## 7. 未完成项

- 旧远端 Host（未包含 `services-mcp-trust` / `decideWorkspaceMcpTrust`）仍无法展示或建立远端
  授权；UI 只能按 `workspaceTrustKnown=false` 保持兼容，需要随远端 CLI 一起升级。
- 会话内提示是 UI 侧从已加载的 MCP store 投影的计数，不是会话协议字段；当远端旧 Host 不返回
  trust 或设置页尚未加载该工作区时不会出现。若要覆盖“会话已建立但从未打开设置页”的场景，
  需要内核在 snapshot/事件里暴露被跳过的项目 MCP（属于协议改动，未在本轮实施）。
- 远端 A6（工作区是否已登记/在线）依赖远端 Host 自身的装配；当前 `createMcpSyncService` 只做
  声明与信任库审核，未额外读取窗口登记表。
