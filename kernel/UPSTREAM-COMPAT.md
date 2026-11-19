# 内核上游兼容声明（ZCode-rs）

> 本文件声明 `kernel/` 与上游 ZCode-rs 的版本关系、兼容边界和验证方式。
> 与 `kernel/CHANGELOG-FORK.md` 配套：变更记录写在 CHANGELOG，**契约**写在这里。
> 代码与迁移的真相以仓库为准；本文件不替代逐文件复核。

## 1. 版本关系

| 项 | 值 |
|---|---|
| 上游仓库 | `https://github.com/MBearo/ZCode-rs`（稳定镜像 `Ebonyhtx/ZCode-rs`） |
| NIBI pin | `6d349ed4c4cf31e05079056c08e6bea495544116`（0.1.67，build 67） |
| 上游最新复核 | 0.1.88，release commit `a7a980de32da5da539d361e937702610b801e03d`，export of source `718d53f43c`（约 1951 文件、build 88、+7 crate、迁移 25） |
| 处置 | **不整体重 pin**。按补丁回填与 NIBI 相关的安全/正确性修复；其余不吸收 |

为什么不全量重 pin：0.1.88 是一次整树导出，直接 merge 会把 NIBI 已经修好的 CVE 下限、`protocol-nibi`、
v2 凭据格式和 `nibi-kernel/` entry 前缀一起打散，并引入 NIBI 不使用的 keyring / pg-store /
protocol-v5 / plugin-store / relay-connect。NIBI 需要的是**语义对齐**，不是代码同源。

## 2. 已回填（补丁式）

| ID | 内容 | 落地提交 | 回归点 |
|---|---|---|---|
| R1 | 项目配置白名单：仓库 `nibi.json` 只保留 `hooks`、`mcp`、`plugins.enabledPlugins`、`plugins.options` | `82ae3d56` | 恶意仓库不能自带 `permission.mode`/`allowedTools`/`storage.*` |
| R2 | `TaskLists` 持 `Weak<Core>`，修内核释放环 | `2213bb2e` | 会话关闭后内核可释放 |
| R3 | `report_findings` 在 `dontAsk` 下直接放行 | `2213bb2e` | `dontAsk` 仍能报出发现 |
| R4 | `tool_search` 按当前运行的工具集搜索 | `2213bb2e` | 子代理搜不到未授权工具 |
| R6 | node-store entry 前缀保持 `nibi-kernel/<kind>`（上游 0.1.88 写 `rust-cli/<kind>`） | `82ae3d56` | Node `restart-entries.ts` 按同一前缀读 |
| R7 | 安全依赖锁不回退 | `82ae3d56` | rusqlite 0.41.1、rustls-webpki 0.103.16、webpki-root-certs 1.0.11、rustix 1.1.6、libz-sys 1.1.31 |
| R12 | 上游门禁脚本 | `82ae3d56` | `scripts/check-kernel-upstream-gates.mjs` |

## 3. 明确不做

- **迁移 25 / 上游 `0025`**：NIBI 的 `0025` 是 `session_database_identity_rename`，上游 `0025` 是
  `session_permanent_deletion`。只有采用 v5 永久删除时才新开 `0026`，并同批补
  `touched_tables` / `needs_backup`；半套回填会让有数据的旧库进入 `backup_required`。
- **keyring / pg-store / protocol-v5 / plugin-store / relay-connect**：NIBI 分别使用文件凭据、SQLite、
  `protocol-nibi`、Host 插件与 SSH/loopback。
- **上游 v2 凭据格式**：上游 `enc:v2:<os|env>:<fp>:...` 与 NIBI `enc:v2:<iv>.<tag>.<ct>` + 每安装 key
  不兼容；不得写入共享 `credentials.json`。
- **上游账号/套餐/网关语义**：NIBI 只保留普通 API-key/Coding Plan 模型预设，不接上游会员体系。

## 4. 兼容契约

NIBI 对上游只承诺以下边界，超出边界不保证可互操作：

1. **不读上游用户数据**：不读取、不迁移、不写入上游 `~/.zcode` 数据根；NIBI 只用 `~/.nibi` 与
   `NIBI_*` 配置。
2. **数据库迁移账本**：`0001–0024` 与上游逐字节相同；`0025` 起为 NIBI 自有迁移，编号不复用上游语义。
   合并任何上游 node-store 代码必须保留 NIBI 的迁移账本与 `nibi-kernel/` 前缀，或同步改 Node 读取方。
3. **插件 ABI**：只兼容 `.nibi-plugin/plugin.json` 清单与 NIBI 的插件契约；不保证上游插件清单
   （`.zcode-plugin` 等）可直接运行。
4. **协议**：会话协议以 `protocol-nibi` / NIBI v4 为准，不跟随上游 protocol-v5。
5. **安全下限**：`Cargo.lock` 的 CVE 下限只升不降；合并上游代码不得把依赖退回 0.1.88 的 lock。

## 5. 验证

```bash
# 上游门禁：entry 前缀 + 安全依赖下限
node scripts/check-kernel-upstream-gates.mjs

# 内核构建与单测
cd kernel && cargo test -p nibi-kernel-agents -p nibi-kernel-api -p nibi-kernel-session

# 许可证与归属
node scripts/check-kernel-licenses.mjs
```

上述脚本均在 CI 与 `pnpm run verify:pre-push` 中执行。

## 6. 下一次上游复核

1. 取上游新 release commit 与 export source hash，记录到 `CHANGELOG-FORK.md`。
2. 按树 diff 逐项分类：安全修复（必须回填）、正确性修复（评估）、NIBI 不使用的能力（不做）。
3. 回填只改必要文件，保留第 4 节的兼容契约；每项补回归测试。
4. 不整体 merge、不整体重 pin；pin 变更必须单独立项并重跑安全门禁。
