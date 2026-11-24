# 插件用例下一批复核材料（2026-11-24）

> 状态：**复核材料已准备，未转正、未加入 Docker/native preset**。PLM-LC-017/018 建议通过；
> PLM-LC-019 受公网 fixture URL 阻塞，不建议转正。

## 运行环境

- Windows 11 本机，E2E 隔离 HOME（`.e2e-home`），`E2E_PROVIDER_HTTP_MODE=replay`。
- pending spec 需要 `NIBI_E2E_MANUAL_REVIEW=1`；PLM-LC-019 另加
  `NIBI_E2E_MANUAL_REVIEW_HOLD_MS=180000`。
- 命令模板：

  ```bash
  cd packages/desktop
  NIBI_E2E_MANUAL_REVIEW=1 \
  E2E_PROVIDER_HTTP_MODE=replay \
  E2E_PROVIDER_REPLAY_FIXTURE_PATH=packages/desktop/test/e2e/fixtures/upstream/common.json \
  NIBI_E2E_SPEC=<spec> \
    pnpm test:e2e:serial
  ```

## PLM-LC-017 已安装行内菜单布局

**结论：建议通过。** run `desktop-e2e-20261124-040332-920`。

- 场景：user 层启用内置 `skill-creator@nibi-official`，在 Settings → Plugins 切到 Workspace
  scope，通过行内「…」菜单暂停插件，形成 `enabledSource=workspace`。
- 观察点：
  - 行徽标为「本工作区覆盖」，toast 为「已在当前工作区停用 技能创建器（覆盖 User 默认）」；
  - 行内菜单只有「启用 / 卸载」两项，无「恢复 User 默认」；
  - 两项均单行、等高（Range 文本行框计数与高度断言）。
- 截图：`.e2e-artifacts/plugin-management/plm-lc-017/installed-row-menu-workspace-override.png`。
- 关键修正：产品规则是**项目层只能禁用插件，Workspace 的「启用」会提升到 user**
  （`bootstrap/src/nibi-protocol/plugins.ts` 的 `setPluginEnabled` 注释）。原 spec 用
  workspace `enabledPlugins=true` 造覆盖，方向反了，Host 会按 user 解析；现改为 user 启用 +
  Workspace 暂停，走真实 UI 路径。同时修了：
  - `selectPluginSettingsScope` 等 Projects 子菜单异步加载，不再把「还没加载」误判成「没有 Workspace 目标」；
  - 启停后等菜单触发器从 disabled 恢复，并留 800ms 让列表刷新/菜单关闭动画落定。

## PLM-LC-018 官方市场节流

**结论：建议通过（离线）。** run `desktop-e2e-20261124-040849-641`。

- 场景：wdio seed 把官方市场 `lastUpdated` 写成启动前 1 分钟（命中 10 分钟节流窗口）。
- 断言：进入商店页、离开后从侧栏重进，官方市场时间戳保持不变；无 `refreshFailure`；
  页面无 `plugin-store-error`。
- 截图：`.e2e-artifacts/plugin-management/plm-lc-018/throttled-reenter.png`（官方市场「更新于」
  保持 seed 时间，页面无错误）。
- 修正：`claude-plugins-official` 在当前 Host 缓存缺失时不会把 seed 的 `known_marketplaces`
  记录投影进 overview；断言改为「记录存在时时间戳不变」，记录缺失本身即没有拉取/失败。

## PLM-LC-019 官方市场进入即刷新（公网）

**结论：环境阻塞，不建议转正。** run `desktop-e2e-20261124-041110-203`。

- 失败：seed 的官方市场 URL `https://cdn-zcode.z.ai/nibi/official-plugin/marketplace.json`
  返回 **404 Not Found**，产品持久化
  `refreshFailure: { code: "plugin_marketplace_invalid", message: "Failed to fetch marketplace: 404 Not Found" }`。
- 判断：这是公网 fixture URL 过期（上游 CDN 路径已不可用），不是刷新逻辑回归。需要运营者给出
  当前官方市场 URL 后复跑；在拿到可用 URL 前保持 pending，不进入正式 CI。

## 代码改动（仅 pending spec / 共享 helper）

- `plugins/manual-review/pending/plugin-management-installed-menu-layout.test.ts`：seed 内置插件；
  user 启用 + Workspace 暂停；等待 scope 菜单/菜单触发器；保留布局与截图断言。
- `plugins/manual-review/pending/plugin-store-auto-refresh-throttled.test.ts`：
  `claude-plugins-official` 记录缺失时不再空指针，记录存在时仍断言时间戳不变。
- `test/e2e/helpers/plugin-management-lifecycle.ts`：`selectPluginSettingsScope` 等待异步
  Projects 子菜单或平铺选项出现。
- **未改产品代码。** 正式 spec `plugin-management-persistence-source` 回归通过
  （`desktop-e2e-20261124-041811-701`）。

## 门禁与遗留

- `pnpm --filter @nibi/desktop typecheck:e2e` 通过。
- `e2e:fixture:check --spec <017/018>` 报 case-local fixture 与 case manifest 缺失：这两条
  pending spec 目前依赖 wdio seed 与 `common.json`，没有独立 case 合同。转正前需要补
  `fixtures/upstream/plugin-management/<case>.json` 与 `fixtures/cases/plugins/<case>.json`，
  或由运营者确认这类纯 UI 用例的豁免口径。
- 复核通过后的转正步骤仍走 `e2e:promote:plugins --reviewed --apply`、单 spec Docker 准入与
  native preset；本文件不代替人工结论。
