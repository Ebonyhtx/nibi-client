# 插件用例下一批复核材料（2026-11-24）

> 状态：**运营者已批准**。PLM-LC-017/018 已转正并完成 Linux Docker 准入；PLM-LC-019 按用例目录的
> `never formal CI` 保持 manual-review 公网 smoke，不转正、不进 preset。

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

**结论：已批准并转正。** 本地 run `desktop-e2e-20261124-040332-920`；Docker replay-isolated
`desktop-e2e-20261124-044245-176` 通过，已写入 `plugins-verified`。

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

**结论：已批准并转正。** 本地 run `desktop-e2e-20261124-040849-641`；Docker replay-isolated
`desktop-e2e-20261124-045909-1079` 通过，已写入 `plugins-verified`。

- 场景：wdio seed 把官方市场 `lastUpdated` 写成启动前 1 分钟（命中 10 分钟节流窗口）。
- 断言：进入商店页、离开后从侧栏重进，官方市场时间戳保持不变；无 `refreshFailure`；
  页面无 `plugin-store-error`。
- 截图：`.e2e-artifacts/plugin-management/plm-lc-018/throttled-reenter.png`（官方市场「更新于」
  保持 seed 时间，页面无错误）。
- 修正：`claude-plugins-official` 在当前 Host 缓存缺失时不会把 seed 的 `known_marketplaces`
  记录投影进 overview；断言改为「记录存在时时间戳不变」，记录缺失本身即没有拉取/失败。

## PLM-LC-019 官方市场进入即刷新（公网）

**结论：已批准，保持 manual/public。** 公网 run `desktop-e2e-20261124-042719-701` 通过；
按用例目录的 `never formal CI`，不转正、不进 Docker/native preset。

- 场景：wdio seed 把官方市场 `lastUpdated` 写成远古时间，进入商店页不点刷新，等待官方市场
  自动刷新；离开后重进命中 10 分钟节流。
- 观察点：进入商店页后官方市场时间戳更新为当前时间（截图显示「更新于 2026/11/24 12:29:02」），
  页面无错误；真实官方市场内容（NIBI 数模工作台）正常展示。
- 截图：`.e2e-artifacts/plugin-management/plm-lc-019/auto-refreshed-on-enter.png`。
- 修正：E2E fixture 之前写死了上游 CDN `https://cdn-zcode.z.ai/nibi/official-plugin/marketplace.json`，
  该路径已 404。现改为从产品默认源 `DEFAULT_PLUGIN_MARKETPLACES` 派生（当前为
  `https://api.nibistudio.cn/plugins/marketplace.json`），不再自己维护第二份 URL。

## 代码改动（仅 pending spec / 共享 helper）

- `plugins/plugin-management-installed-menu-layout.test.ts`：seed 内置插件；
  user 启用 + Workspace 暂停；等待 scope 菜单/菜单触发器；保留布局与截图断言。
- `plugins/plugin-store-auto-refresh-throttled.test.ts`：
  `claude-plugins-official` 记录缺失时不再空指针，记录存在时仍断言时间戳不变。
- `test/e2e/helpers/plugin-management-lifecycle.ts`：`selectPluginSettingsScope` 等待异步
  Projects 子菜单或平铺选项出现。
- `test/e2e/helpers/plugin-cdn-zip-marketplace.ts`：官方市场源从 `DEFAULT_PLUGIN_MARKETPLACES`
  派生，去掉写死的上游 CDN URL；`conversation-session-plugin-store-try-states` 的离线 marker
  同步改为 NIBI 官方源。
- **未改产品代码。** 正式 spec `plugin-management-persistence-source` 回归通过
  （`desktop-e2e-20261124-041811-701`）。

## 门禁与遗留

- `pnpm --filter @nibi/desktop typecheck:e2e` 通过。
- PLM-LC-017/018 已补 case manifest 与 case-local fixture，`e2e:fixture:check --spec <017/018>` 通过。
- 两条 spec 逐条 replay-isolated Docker 通过（run id 见上），`plugins-verified` 全量 **13/13**
  通过（`desktop-e2e-20261124-050210-597`）；macOS/Windows native CI 同集合各 **13/13** 通过
  （macOS `desktop-e2e-20261124-052213-003`、Windows `desktop-e2e-20261124-052437-667`；
  GitHub run 45331930481）。
- PLM-LC-019 按 `never formal CI` 保持 manual/public，不补正式 case 合同。
