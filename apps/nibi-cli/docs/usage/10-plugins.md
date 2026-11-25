# 10 · Plugins

插件用于分发技能、自定义命令、Hook 和 MCP 等扩展。CLI 支持安装和市场管理，不再限于本地目录。插件数量、版本和默认启用状态会变化，以清单为准。

## 常用命令

```sh
nibi plugins list --json
nibi plugins list --available --json
nibi plugins marketplace list --json
nibi plugins marketplace add /absolute/path/to/marketplace
nibi plugins install example-plugin@example-market --scope user
nibi plugins enable example-plugin@example-market
nibi plugins disable example-plugin@example-market
nibi plugins update example-plugin@example-market
nibi plugins uninstall example-plugin@example-market --keep-data
nibi plugins marketplace update example-market
nibi plugins marketplace remove example-market
```

示例市场和插件须先存在。`--scope` 支持 `user` 和 `project`；修改项目启用配置时指定对应工作目录。安装、启用、更新和卸载是不同操作，完成后重新查看清单，并用新进程验证。

`plugins list` 可以独立触发内置插件准备，无需先运行一次模型对话。全局关闭插件、缺少资源或准备失败也可能导致列表为空；先看诊断，不要用付费 prompt 作为初始化步骤。

## 本地插件

```text
example-plugin/
  plugin.json
  skills/greet/SKILL.md
  mcp.json
  commands/hello.md
```

根 `plugin.json` 遵循 Agent Plugins 1.0.0；NIBI 专属组件放
`extensions["com.nibistudio.nibi"]`。manifest 示例：

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "example-plugin",
  "version": "0.1.0",
  "description": "示例技能与命令",
  "extensions": {
    "com.nibistudio.nibi": {
      "apiVersion": "1",
      "commands": "./commands"
    }
  }
}
```

技能和命令内容见[Skills](08-skills.md)。运行配置启用本地目录：

```json
{
  "plugins": {
    "enabled": true,
    "dirs": ["/absolute/path/to/example-plugin"]
  }
}
```

验证：

```sh
nibi plugins validate /absolute/path/to/example-plugin --json
nibi plugins list --json
nibi skills list --json
nibi commands list --json
```

插件可携带本地可执行内容。安装前审查其 Hook、MCP 命令、依赖和数据访问范围。validate 只检查结构与诊断，不证明插件安全或所有功能可用。兼容 manifest 中的字段也不一定具有运行时实现；以加载诊断为准。

## 权限与同意

- 内置与官方市场插件沿用既有信任，不需要额外同意。
- 本地目录与第三方市场插件里，只有 skills / commands / agents 的可以直接启用；出现 Hook 或 MCP 时会启动子进程，必须逐插件、逐版本显式同意 `process`（MCP 还要求 `network`）。
- 桌面端在启用时弹同意框；CLI 用 `nibi plugins enable <plugin> --accept-permissions`。未同意时插件保持停用并给出 `plugin_consent_required` 诊断。
- 同意记录在 `<插件存储根>/plugin-consents.json`；版本变化或权限变多需要重新确认。撤销同意后插件在下次加载时停用。
- `full-access` 对本地/第三方插件永远不会授予；声明了也只会保留在请求列表里，不进入 required。
- 同意与撤销写入 `<插件存储根>/plugin-audit.ndjson`，只记录插件 id、版本和权限，不记录命令或环境变量。
- 扩展代码（`extensions["com.nibistudio.nibi"].runtime`）还受五项 NIBI Extension 能力约束：读会话、读工作区文件、打开自己的视图、读写自己的设置、发通知。读会话/读文件逐版本同意，存在 `plugin-grants.json`；详见 [插件扩展运行时](../../../../docs/plugin-extension-runtime.md)。

## 数据与复现

默认目录为 `~/.nibi/cli/plugins/`：市场索引、安装记录、`cache/` 中的版本内容，以及 `data/` 中的持久数据分别管理。启用态还保存在运行配置中。只复制缓存不能完整恢复安装和启用状态。

插件需要持久写入时使用插件数据目录，不要改插件代码目录。卸载前确认是否保留数据，批量实验固定版本并归档非敏感清单。不要在比较实验中自动更新市场或插件。
