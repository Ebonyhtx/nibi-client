# NIBI 插件扩展运行时（v1）

## 目标

插件代码只拿宿主能力，不给模型注册工具。要给模型工具就带一个 MCP server（`mcp__<server>__<tool>` 管线已有权限、ToolSearch 与用量统计）。

## 清单

```json
{
  "name": "example",
  "version": "1.0.0",
  "extensions": {
    "com.nibistudio.nibi": {
      "runtime": { "apiVersion": "1", "entry": "./extension.mjs" },
      "capabilities": [
        "nibi.sessions.read",
        "nibi.workspace.files.read",
        "nibi.settings.own",
        "nibi.notifications.show"
      ]
    }
  }
}
```

- `runtime.entry` 必须是插件根内的相对路径；越界、缺失或非文件都只报诊断，不执行。
- `capabilities` 是闭集；未知能力会让插件停用并报 `plugin_capability_unsupported`，不静默忽略。
- `host` 作用域只对 builtin/official 开放；community/local 请求会被拒绝。
- 扩展代码只能在 NIBI 根 `plugin.json` 布局（native / agent-plugins）声明；`.claude-plugin` / `.codex-plugin` / `.zcode-plugin` 里的 `runtime` 标为 `skipped: ["runtime"]`，声明式组件仍可用。

## 五能力（v1）

| 能力 | 作用 | 授权 |
|---|---|---|
| `nibi.sessions.read` | 当前工作区会话列表 | 逐版本同意 |
| `nibi.workspace.files.read` | 工作区内文件读取；拒绝 `.env*`、`*.pem`、`*.key`、`.ssh/**`、`.aws/**`、`.nibi/**`、`.git/config` | 逐版本同意 |
| `nibi.ui.view` | 打开自己的视图 | 无需确认 |
| `nibi.settings.own` | 读写插件自己的 `settings.json` | 无需确认 |
| `nibi.notifications.show` | 发通知；限 1/分钟、20/天 | 无需确认 |

敏感能力存在 `<插件存储根>/plugin-grants.json`：

```json
{
  "version": 1,
  "plugins": {
    "example@inline": {
      "capabilityGrants": [{ "id": "nibi.sessions.read", "scope": "workspace" }],
      "consentedVersion": "1.0.0",
      "consentedAt": "2026-11-22T…",
      "epoch": 3
    }
  }
}
```

版本变化或能力变多都要求重新确认；撤销会清空授权并把 `epoch + 1`。授权与权限同意/审计分开记录，审计只写插件 id、能力、版本和结果，不写参数正文。

## 进程隔离

| 信任 | 层级 | 进程 |
|---|---|---|
| builtin / official | T1 | 共享扩展宿主 |
| community | T2 | 共享独立扩展宿主 |
| local | T3 | 每个插件独立进程 |

- 子进程用逐行 JSON 协议；插件自己的 `console.*` / stdout 都转成日志，不能污染协议。
- 子进程设置 `--max-old-space-size=256`。
- 非 Electron 且 Node 支持 `--permission` 时，额外限制文件系统：只允许插件根、插件数据目录和当前工作区读取，数据目录可写。Electron 下该模型不可用时只做进程隔离与内存上限，不能声称已做文件系统沙箱。
- 扩展宿主随桌面 Host 进程启动（按工作区首次读取插件面时激活）；Node 内核 app-server 复用同一实现。扩展代码始终在本机进程侧运行，不跟随远程工作区。

## JS API

```js
export async function activate(context) {
  context.plugin;                 // { id, name, version }
  await context.nibi.sessions.read({ limit: 20 });
  await context.nibi.workspace.readFile("README.md");
  await context.nibi.settings.get();
  await context.nibi.settings.set({ key: "value" });
  await context.nibi.notifications.show({ title: "Ready" });
  await context.nibi.ui.openView("panel");
}
export async function deactivate() {}
```

`ui.openView("panel")` 请求在当前窗口打开该插件清单里的同名 `ui.surfaces[]` 面板：

- 桌面 Host 内的扩展宿主把请求转成 renderer 事件，复用现有侧栏标签页链路；没有活动会话时不打开，只提示“面板暂不可用”。
- 无 UI 的宿主（纯 Node app-server / headless）没有打开视图的处理器，调用返回 `capability_unavailable`，不会假装打开。
- `ui.surfaces[]` 里没有这个 id、插件已停用或宿主没有沙箱时同样不会打开。

`notifications.show` 在桌面显示应用内 toast；headless 宿主退化为日志。

## 插槽

`ui.surfaces[]` 可增加 `slot`：

- `composer.status`：已启用插件在输入框工具条渲染一个入口。
- `nav.primary`：已启用插件在主导航渲染一个入口；没有活动会话时不显示（侧栏标签页需要会话 owner）。
- 两个锚点都走现有侧栏标签页打开链路，不新建页面系统。
- **只做这两个插槽是决定，不是缺口**：上游的 5 slots 面**有意不接**（2026-11 定案，见
  `docs/plugin-platform-status-2026-11-25.md`）。不要按「补齐上游 parity」再引入其余插槽。

## 已知边界

- 代码插件不能注册模型工具、不能直连模型。
- 不热加载：安装、启停、授权变化在 App 重建后生效。
- `NIBI_PLUGIN_*` 变量仍由清单/MCP 层展开；扩展代码拿到的是 `context` 而非 PATH 回退。
- 远程工作区不运行本机扩展代码以外的远端代码。
