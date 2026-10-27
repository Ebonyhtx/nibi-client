# NIBI 插件商店术语表

插件设置页与市场浏览/安装体验的领域词汇。涉及商店 UI、目录数据或插件生命周期的改动，以本文件为术语裁决来源。

## 市场与来源

**Official Marketplace（官方市场）**
NIBI 官方运营的分发渠道，市场 id 为 `nibi-official`。内容由内置插件与 CDN 插件组成；它是分发渠道，不是作者归属，因此可以收录社区作者的插件。

**Builtin Plugin（内置插件）**
随应用包分发、启动时播种进官方市场的插件，是官方插件的子集。

**CDN Plugin（CDN 插件）**
官方市场中通过 NIBI 内容主机分发、以 sha256 校验的 zip 包按需下载安装的插件。

**Personal Source（个人来源）**
用户自行添加的一切插件来源：其他市场、git/GitHub/URL、本地目录与 inline 插件。

**Catalog Auto-Refresh（目录自动刷新）**
进入商店页时对官方市场目录的节流后台刷新，用户无感知；只覆盖官方市场。

**Manual Refresh（手动刷新）**
商店页顶栏刷新按钮触发的全市场刷新，不受自动刷新节流影响。

## 商店页结构

**Public Segment（公开）**
官方市场中由产品团队维护的条目。发布字段 `publisherType` 为 `official`。

**Community Segment（社区）**
官方市场收录的外部维护插件，发布字段 `publisherType` 为 `community`。

**Personal Segment（个人）**
全部个人来源的目录，按市场分组。

**Featured（精选）**
公开分段顶部的策展区，名单来自官方目录的 `featured` 字段。

**Recommended（推荐）**
个人分段顶部的策展区，名单由仓库内的推荐清单维护。

**Manage Installed View（插件管理）**
商店页内的管理视图，保留全局默认与项目覆盖，可返回浏览并保留搜索、来源与管理范围。

**UI Plugin（界面插件）**
清单声明有效 `ui.surfaces`、目录携带 `componentTypes: ["ui", …]` 的插件。归属、用途与 UI 能力是独立维度。

## 元数据

**Store Listing（商店信息）**
目录条目的展示元数据：显示名、icon、分类、开发者、网站/隐私政策/服务条款链接、hero 图、示例提示词。它描述“如何在商店里呈现”，不影响插件功能。

**Plugin Manifest（插件清单）**
插件包内 `plugin.json` 的功能性定义（commands/agents/skills/hooks/mcpServers/userConfig 等），描述“插件是什么、做什么”。

**Example Prompt（示例提示词）**
Store Listing 提供的可点击提示词；点击后新建会话并预填，不自动发送。

## 生命周期

**Plugin Lifecycle（插件生命周期）**
从发现、查看、安装、配置、启停、使用、检查更新、升级、持久化恢复到卸载的完整路径。每个阶段都要同时验证可见 UI 状态与对应的持久化或运行时结果。

**Restorable Builtin（可恢复内置插件）**
被用户卸载并进入持久化抑制状态的内置插件。重启不会自动重新播种；它仍出现在公开分段，并通过“安装”执行干净恢复。

**Orphaned Installed Plugin（孤立已安装插件）**
对应个人来源已被删除、但安装目录和用户数据仍保留的插件。它仍可使用、配置、启停和卸载；来源重新添加前不能更新。
