# 远程目标（source-server）

SSH / WSL / Docker 远程目标的**数据契约、版本兼容性判定与连接日志边界**。实现落在
`packages/shared/src/source-server/`，由 `@nibi/shared` 统一再导出。

## 这个模块负责什么

- 远程目标的配置与记录 schema（`contracts.ts`）：连接 profile、已保存服务器、工作区历史、
  迁移报告、更新目标。
- 版本兼容性（`compatibility.ts`）：当前构建的兼容清单、版本比较、谁该升级的判定。
- 连接失败归一化（`connectionErrors.ts`）：把系统错误码 / 阶段兜底映射成稳定、可判级的
  `code`，UI 只认 code，不解析错误文本。
- 用户可见日志的脱敏边界（`connectionLog.ts`）：主机、路径、凭据、ANSI 控制序列。

## 边界

- 只做**纯数据与判定**：不发起连接、不读写文件、不持有会话状态；实际 SSH/WSL 连接在
  `@nibi/services` 的运行时里。
- 对外只通过 `index.ts`（桶）与 `contract.ts`（行为契约）访问；`contract.test.ts` 把实现与
  契约逐项对齐，改名或改签名会先红。
- `connectionLog.ts` 的 ANSI 清除必须保留一条 `oxlint-disable-next-line no-control-regex`：
  该正则要匹配的就是控制序列本身。这条 exception 登记在 `architecture-policy.yaml` 的
  `disable-count`，不是漏配。

## 为什么单独登记为 managed

`shared` 整体仍是 legacy（`managed: false`），但这个子目录已经是独立边界：只有 `shared`
包内部按相对路径进它，包外一律经 `@nibi/shared`。先把它单独纳入 managed，让它的行数上限、
依赖声明、lint-disable 数与环检测真正生效，而不是等整个 `shared` 包接管。
