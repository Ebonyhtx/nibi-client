# Computer Use 实施台账（`@nibi/cua` 真实现）

> 背景与决策见本包 `README.md` 与 `packages/nibi-cua/vendor/freeall12-computer-use/PROVENANCE.md`。
> 一句话：**上游把电脑操控拆成五层；我们缺的那层是"原生引擎"。本包就是把这一层补上，
> 原生能力由 Cua Driver（MIT，六平台预编译）提供，语义与安全留在我们自己手里。**

## 一、链路分工（谁负责什么）

```
模型（读 skill/docs，写 JS；每 cell 全新 Worker）
  ▼ mcp__node_repl__js（node-repl-host：桥 + capability method 转发）
插件 SDK（computer-use-client.mjs，MIT，随市场分发）── Symbol 桥 ──▶ 宿主
  ▼ 运行时 createComputerUseRuntime({ brokerSocketPath })   ← 本包（语义在这儿）
      · state_id / 元素索引台账 / 帧台账（16 帧 + 墓碑）/ ActionSettler
      · 控制器租约 / possibly_sent 防重放 / kill switch / 双基线
  ▼ NDJSON over 命名管道（win32 `\\.\pipe\nibi-cua-<uuid>`）/ Unix socket   ← 本包 broker.js
Helper（helper/main.js）                                   ← 本包（新写的"上游 ZCode Computer Use.app"位置）
  ▼ 引擎适配层 engine/cua-driver.js
Cua Driver（@trycua/cua-driver：listApps / listWindows / getWindowState / click / …）
  · macOS：Accessibility + ScreenCaptureKit（需两项 TCC，`./electron` 入口提供授权引导）
  · Windows：UI Automation + native input（无需 TCC）
```

职责边界按上游切分，**引擎可换**：将来换自研原生层，只改 `engine/` 一个适配器。

## 二、宿主契约（我们的代码即契约，勿凭记忆改）

| 项 | 约定 | 出处 |
| --- | --- | --- |
| 启动 | `fork(runtime.command, [entry, "--socket", <pipe|sock>, "--parent-pid", <pid>], { cwd: runtime.root, env: {…, NIBI_CUA_HELPER_ADDON: <原生件路径>, ELECTRON_RUN_AS_NODE: "1" } })` | `packages/services/src/cua-permission-broker/windowsCuaDevHelperHost.ts` |
| 握手 | Helper 经 child channel 发 `{protocol:"nibi-cua-windows-dev/v1", type:"transport_ready"|"ready", socketPath, pid}`；失败发 `{type:"error", message}`；宿主可发 `{type:"shutdown"}` | 同上（`parseReadyMessage`） |
| 线上 | 一行 JSON：请求 `{id, method, params}` → 响应 `{id, ok:true, result}` / `{id, ok:false, error:{code,message}}` | `broker.js` |
| 方法名 | **= 工具名**：14 工具 + `permission_status` + `helper_health` | `broker.js#BROKER_METHODS`；语义见 `vendor/freeall12-computer-use/docs/zcode-computer-use.md §3` |
| 端点铸造 | win32 命名管道；Unix `<tmp>/nibi-cua-<uid>/znrc-<uuid>.sock`（0700） | `broker.js#mintBrokerSocketPath` |
| 序列化 | **必须容忍 BigInt**（uniffi 的 u64 字段；`JSON.stringify` 遇 BigInt 直接抛，实测踩过） | `broker.js#jsonSafeReplacer` |
| 错误信封 | `{code, message, details?}`——**details 必须贯通**（`CONTROLLER_BUSY` 的 `owner`、`STALE_STATE` 的 state_id 都靠它说清） | `broker.js#errorResponse*` |
| 结果信封（给 SDK） | MCP 形状：成功 = `{content:[{type:"text",text:<树>}], structuredContent:<收据>}`；错误 = `{isError:true, content:[{text:<{code,message}>}]}`；冷启动 = 非错误信封带 `kind:"CUA_NOT_READY"`；`possibly_sent` = 成功信封里 `dispatch_status`（由 SDK 转成 actionSent 错误） | 插件客户端解析逻辑（`computer-use-client.mjs#receiptOf/assertOk`） |

## 三、工具 → 引擎映射

| 工具（14） | 层 | 引擎（Cua Driver） | 状态 |
| --- | --- | --- | --- |
| `list_apps` | READ_ONLY | `listApps()` | ✅ 已通 |
| `list_windows` | READ_ONLY | `listWindows({pid?, onScreenOnly})` | ✅ 已通 |
| `get_app_state` | READ_ONLY | `getWindowState({windowId})` | ✅ 已通（AX 树/栅格字段的规范化待下一批） |
| `permission_status`（辅助） | READ_ONLY | macOS 走 TCC 探针；Windows 恒 granted | ✅ 已通 |
| `helper_health`（辅助） | READ_ONLY | —（进程身份） | ✅ 已通 |
| `left_click` | T1_INPUT | `click{element_token|x,y,window_id,delivery_mode}` | ✅ 已通（帧坐标 → 窗口相对坐标的校验在运行时侧，待 P2 余项） |
| `left_click_drag` | T1_INPUT | `drag{from_x,from_y,to_x,to_y}` | ✅ 已通 |
| `scroll` / `type` / `key` | T1_INPUT | `scroll{direction,amount}` / `type_text{text}` / `press_key{key,modifiers}` | ✅ 已通 |
| `paste` | T1_INPUT | `clipboard_write` + `hotkey{c-v}`（借还还原用户剪贴板待运行时侧做） | ✅ 已通 |
| `set_value` | T1_INPUT | `set_value{element_token,value}` | ✅ 已通 |
| `select_text` / `perform_action` | T1_INPUT | AX 选区 / `invoke_menu` | ⏳ 未接线（fail-closed；需要元素的 actions 广告） |
| `request_access` | READ_ONLY | macOS TCC 引导（`./electron` 的 `requestMacOSPermissions`） | ⏳ 待接线 |
| `stop_computer_control` | SAFETY | 本地闩锁（运行时）+ `shutdown()` | ⏳ 待接线 |

## 四、为什么这样做（决策要点）

* **不转发上游产物**：上游 `tools/cua-helper`（Node SEA + ax_native.node）来源不公开，转发不成立。
* **不自己造原生件**：Cua Driver 六平台预编译、MIT、Windows 台账 122/122、后台输入（不抢焦点）
  是它的强项；macOS 无需我们构建（Mac 只影响"发布"——签名/公证，不影响实现）。
* **语义留给自己**：state_id / 帧台账 / 租约 / 防重放 / kill switch 决定安全性，不外包。
* **规格与测试有据**：`vendor/freeall12-computer-use/`（MIT 快照，含 14 工具 schema、行为准确的
  mock broker、18 项参考测试）；离线用 `test/fake-cua-driver.mjs` 跑整链路。

## 五、阶段与验收

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| P0 ✅ | 规格快照 + PROVENANCE；参考测试 18/18 | `vendor/.../reference/test.mjs` 全绿 |
| P1 ✅（本批） | 协议层真实现（客户端 + 服务端）；Helper 骨架 + 引擎适配；只读 5 个方法打通 | `node --test packages/nibi-cua/test/brokerProtocol.test.mjs` 6/6；`NIBI_CUA_ENGINE_SMOKE=1 NIBI_CUA_ENGINE_MODULE=<driver entry>` 时 7/7（真引擎列出本机应用/窗口） |
| P2a ✅（本批） | **Helper 侧**语义（跨会话租约 CONTROLLER_BUSY+owner、kill switch 闩锁+两豁免、观察收据 state_id、possibly_sent 回执）+ 7 个输入工具接线（click/drag/scroll/type/key/paste/set_value） | `npm test` 11/11（含租约/kill switch/possibly_sent/观察收据五例）；真引擎档 7/7 |
| P2b ✅（本批） | **运行时侧**：`runtime/{index,session,envelope}.js`——元素索引台账（STALE_STATE / ELEMENT_UNAVAILABLE）、帧台账（16 帧 + 32 墓碑、坐标隐式绑最新帧、伪造/过期帧 `action_sent=false`）、ActionSettler（300ms 起、指纹连续两次一致或 5s 上限）+ `effect_evidence`/`state_sync_status`、子代理禁用、kill switch 透传、`possibly_sent` 不等不重试、`closeSession` 释放租约、给 SDK 的四种 MCP 信封 | `npm test` **18/18**（协议 6 + Helper 语义 5 + 运行时 7）；真引擎档 7/7；三处类型门禁（services / desktop host / node-repl-host）全绿 |
| P2c ✅（本批，Windows） | ① `perform_action`：**只认元素广告过的动作**，映射到引擎的 `click`（省略 action＝默认 invoke）/`click{action:"expand"}`/`set_value`，**菜单路径**（`文件(F) > 新建`）走专用 `invoke_menu`（按标签逐级解析、不碰像素）；② `select_text`：引擎**没有** text-range 原语 → **诚实拒绝**并给替代（`set_value`/`click`+`key`）；③ 观察信封补 `image_ref` 四键块（`frame_id/width/height/actionable/note`，带截图时才发）；④ `possibly_sent` 记号（`forceFullTreeNext`） | 离线 **20/20**（新增 image_ref 两条断言）；真机 `test:acceptance:p4b` **5/5**（新增：菜单路径开新页 + 未广告动作被拒 + select_text 诚实拒绝） |
| P3a ✅（本批，Windows） | 打包：`packages/desktop/scripts/stage-cua-helper.mjs` 把 helper + 引擎打成 `<resources>/tools/cua-helper/`（含 `runtime-manifest.json` 九键与 entry/addon sha256）；`prepare:runtime-assets` 串上 `prepare:cua-helper`；`electron-builder.config.js` 的 `extraResources` 加 `tools/cua-helper`；依赖 `@trycua/cua-driver@0.34.1` 已进包清单；第三方声明生成器补了 11 个包的固定许可原文（`third-party/npm-overrides.json` + `third-party/upstream/*.txt`） | **宿主解析器 `resolveWindowsCuaRuntime` 接受打包产物** ✓；打包 Helper 在**无任何环境变量**下起得来（引擎按包内相对路径解析）→ `apps=190 windows=9`、`helper_health.engine=cua-driver`、退出码 0 ✓；`node scripts/licenses.mjs notices` exit 0 且 notices 里出现 `cua-driver`/`@ubjs` ✓ |
| P5 ✅（本批，Windows） | **接进客户端**：`stage-cua-helper.mjs` 现在同时满足**两套契约**——产品通道的 `runtime-manifest.json`，以及 dev 通道的 `package.json#nibiCuaRuntime`（`{schema:1, windows:{entry, nativeAddon}}`，路径要规范相对形式）；`run-desktop-dev.cmd` 设 `NIBI_CUA_DEV_ROOT=<client>/.staging/tools/cua-helper`；打包版无需改动（`resolvePackagedRuntime` 默认取 `process.resourcesPath`，`extraResources` 已把目录放到 `tools/cua-helper`） | `test/wiringAcceptance.test.mjs` **1/1**：走 services 真实工厂（`createDefaultCuaProductHelper` → `resolveWindowsCuaRuntime` → `host.start()`）→ 日志 `Windows Computer Use Helper ready { generation: 1, pid: … }` → `checkHealth` 返回 `nibi-computer-use-win32-x64` + pid → `stop()` 干净退出 |
| P3b | macOS 侧：宿主解析器（现在只有 win32 分支）、嵌套二进制重签与公证、`LSMinimumSystemVersion` 对齐；asar 解包已在 extraResources 路线下自然满足（helper 在 asar 之外） | macOS 上走一遍 P4 |
| P4a ✅（本批，Windows） | 真机验收第一档：`test/nativeAcceptance.test.mjs`（可选，默认跳过）——对我们**自己 spawn 的记事本**跑"观察 → 打字 → 重读 AX 树验证" | `NIBI_CUA_NATIVE_ACCEPTANCE=typed node --import tsx --test test/nativeAcceptance.test.mjs` **1/1 通过**：引擎回执写的是"**通过 PostMessage 后台投递 26 个字符**（未抢焦点）"，随后重读 AX 树确认文本已在 ✓ |
| P4b ✅（本批，Windows） | 真机验收第二条：`test/nativeAcceptanceP4b.test.mjs`（可选，默认跳过）——① **经典闭环**：计算器 `六 → 乘以 → 七 → 等于` 后**重读显示区**看到 42；② **出错不骗人**：伪造帧号 / 越界索引 → 结构化拒绝（`STALE_STATE` / `ELEMENT_UNAVAILABLE`）；③ **kill switch 跨会话真闩锁**：闩锁后另一会话输入被拒（`CONTROL_STOPPED`）、`request_access` 仍可用、**重读界面确认字没落进去** | `test:acceptance:p4b` **3/3 通过**（全部走运行时那一层，也就是模型真正的可见面） |

## 六之一、P2b 的实现要点（下一个人接手要知道）

* **两道闸是独立的**：会话内台账（元素索引/帧）与跨会话租约各自校验；"B 会话没观察过就点"先撞台账的
  `STALE_STATE`，不是 `CONTROLLER_BUSY`（测试里专门钉了这一条）。
* **`frame_id` 必须透传**：引擎（`get_window_state{includeScreenshot}`）回的帧号在规范化时丢过一次 →
  坐标动作全被判"没有新鲜帧"（实测踩过，已在 `normalizeObservation` 修正并有测试）。
* **打包时不要 require.resolve 上游包**：`@trycua/cua-driver` 的 `exports` 不暴露 `./package.json`，
  `@ubjs/*` 连可解析的 main 都没有（`ERR_PACKAGE_PATH_NOT_EXPORTED`）→ 改成按 `node_modules` 逐级找目录
  （`stage-cua-helper.mjs#packageJsonOf`）。同理，`child_process.fork(command, argv)` 的**首参必须是模块**
  （`execPath: command`），照抄宿主的 `defaultChildProcess.fork` 才不会踩 `Unknown file extension ".exe"`。
* **第三方声明生成器会拦新依赖**：缺固定许可原文的包会让 `node scripts/licenses.mjs notices` 直接失败
  （实测 11 个：`@trycua/cua-driver` + 10 个 `@ubjs/*`）→ 按仓库既有约定把许可原文存进
  `third-party/upstream/<sha256>.txt` 并登记 `third-party/npm-overrides.json`（带 sha256 校验）。
* **引擎字段名只有实测才知道**（写成注释免得下次又丢）：元素是 `role` / `label` / `elementToken` /
  `frame{x,y,w,h}` / `value` / `actions`；窗口状态输入要 `pid` + `windowId`（**bigint**）；
  动作工具（`set_value`/`type_text`/…）大多**必须带 pid**，缺了就是 `Missing required integer field pid`
  —— 实测连续踩了三次（窗口状态一次、打字一次、值设置一次），所以 `createHelperBackend` 里
  `resolvePid` 是唯一入口：显式给就用，否则按 `window_id` 现查。
* **简化项（有意，非缺陷）**：收敛等待用的是运行时侧树指纹；厂商的"Helper 侧 snapshotCache（数据变没变）"
  我们没有额外再问一次引擎的 diff 基线；`possibly_sent` 之后没有强制下一次整树观察。都记在 P2c。

## 六之一·补二：P2c 的两个取舍（有意，不是偷懒）

* **`select_text` 我们不做假**：引擎工具面里没有任何 text-range 原语（实测翻遍 57 个工具，只有
  `set_value`/`click`/`key`/`page`），所以它明确抛 `ACTION_UNAVAILABLE` 并给出替代路径。上游那份
  之所以能按范围选，是因为它的 `ax_native.node` 直接走 AX 的 `AXSelectedTextRange`——这正是"引擎能换、
  能力可以有差"的地方，我们宁可少一个动作，也不编一个"看着像成功"的假动作。
* **观察永远是整树**：规格里默认是 diff（`disable_diffing` 才取整树），我们**一直返回整树**——
  错的 diff 比全量更危险（上游自己就为"模型没见过的树被当增量基线"踩过飞书 930 元素的坑）。
  `forceFullTreeNext`（possibly_sent 后必须整树）我们已记账，等将来真做 diff 时它就是开关。

## 六之一·补：P4b 当场抓到的缺陷（已修）

引擎把"拒绝/失败"放在**返回值**里（`{isError:true, errorCode, text}`），不是抛异常。我的
`inputAction` 原来把任何"没抛异常"当作成功 → 回执标成 `dispatch_status:"sent"` —— 也就是说
**动作被引擎拒绝时，模型会看到"已发送"**，正是我们最不能接受的那种骗人。现在 Helper 里加了
`assertEngineOk`（所有工具调用都过），拒绝一律抛出并带 `errorCode`，由运行时翻成
`isError:true` + 结构化码（`action_sent=false`）。这条只有真机验收能抓出来，离线假引擎永远绿灯。

## 六之一·补三：接入（P5）的两个"契约必须精确"点

* **dev 通道**读的是 `package.json#nibiCuaRuntime`，且键必须**恰好**是
  `{schema:1, windows:{entry, nativeAddon}}`；路径要**规范相对形式**（无反斜杠、无 `./` 前缀、无 `..`）。
  我第一版按"顶层 entry/addon"写，直接被 `invalid-package` 拒（诊断文案只给了泛化提示，得回代码里
  读 `requireExpectedPackage` 才知道确切形状）。
* **产品通道**不需要额外接线：`resolvePackagedRuntime` 会在没传 `resourcesPath` 时默认
  `process.resourcesPath`，而 `extraResources` 已把目录放到 `<resources>/tools/cua-helper` ✓。
  所以**打包版本来就该亮**（真机验证待一次完整桌面包构建）；dev 版才需要 `NIBI_CUA_DEV_ROOT`。
* Helper 是**懒启动**的：应用启动时只 ping 稳定 socket，真正的 spawn 发生在一次会话解析 CU MCP 时
  ——所以"启动后日志里没有 helper"是正常的，别据此判断没接上。

## 六之一·补四：用户报的三件事（2026-10-11）

1. **设置页缺"电脑操控"**：`packages/ui/src/lib/settingsNavigation.ts` 的 `HIDDEN_SETTINGS_SECTIONS`
   **硬写着 `computerUse`** ——那是"引擎不可用"时期把整页一并藏的（上游正式版一直显示这一页）。
   已从隐藏集合移除。
2. **状态条那句"NIBI 正在操作电脑"没有图标 —— 更正：那颗 pill 是我们自己画的**，不是引擎侧。
   它是 `packages/desktop/src/main/windowsCuaOperationIndicator{Content}.ts`（Windows 透明置顶窗口 +
   内联 HTML：三个脉冲点 + 文案）。我第一次判成"引擎侧 PiP"是**搜索方法错**：按用户转述的"操控"去搜，
   而代码里写的是"操作"（`NIBI 正在操作电脑`）；而且当时引擎根本没起来（模型报 unavailable），
   它不可能画出任何东西——这条自证早就摆在那里，我漏了。修法：把 `build/icon.png`（NIBI 鸟头）缩到
   96×96 存成 `build/cua-indicator-mark.png`，**内联**进提示条 HTML（CSP 是 `default-src 'none'`，
   外链图片一律被拒，所以放行 `img-src data:`），宽度同步补偿（zh 234→260、en 308→334）。
   离屏渲染验收：`[鸟头] ••• NIBI 正在操作电脑`，文字不裁。
   （上游那颗 PiP 是另一套东西——引擎的 `experimental_pip`，我们构建里默认关。）

3. **电脑操控没成功（模型报 setup [unavailable]）**：真因是**端点名字对不上** ——
   懒启动路径注入的是 `resolveBrokerSocketPath()`，而我把它实现成了"随机管道名"，
   但宿主/Helper/探针用的是**稳定**名字（图谱实测名 `\.\pipe\nibi-cua-helper-default`）。
   agent 带着一个没人监听的管道名去连 → 运行时只能报 unavailable。已改成：
   **稳定端点 = `\.\pipe\nibi-cua-helper-<数据根指纹>`**（`-default` 只属于默认实例；
   dev/换根实例各自一个名字，不串台），`mint`/`resolve` 都返回它；测试/临时场景用显式命名的
   `mintEphemeralBrokerSocketPath()`。Helper 也支持"没有 --socket 时回落到稳定端点"。

## 六之一·补五：端点修完仍 unavailable 的**第二层**真因 —— 冷启动竞态（2026-10-11 深夜实测）

端点修复后真机仍报 `Computer Use is unavailable for this node_repl session`。逐进程读环境块
（NtQueryInformationProcess 读 PEB）后定位：

* **因果链**：应用启动即自动 spawn 工作区 agent（01:17:37.131/.145/.154 三个 app-server）→
  首次 `resolveSpawnEnv` 触发 helper 冷启动 → spawn 准入线 **1s 只等 transport_ready** →
  旧 helper **先加载引擎（~1.04s）再绑管道** → 三个 spawn 全部以「差 5~40ms」输掉竞态，
  env 里永久带上 `NIBI_CUA_PERMISSION_BROKER_UNAVAILABLE`（fail-closed 按设计）→
  helper 38ms 后 ready 也**救不回已 spawn 的 agent**（设计约束"不回收已有 Agent"）→
  之后每个 turn **复用**这些进程 → node_repl 的 broker 永远为空 → 永远 unavailable。
  这解释了"每次重启应用后测都失败"（10-09/10-10/10-11 三天全部命中同一竞态）。
* **修法（顺着既有的两阶段握手设计）**：helper 现在**先绑管道发 `transport_ready`（毫秒级），
  引擎异步加载**，就绪后补发 full `ready`；工具调用经 deferred 代理等引擎（backend 不感知），
  `helper_health` 立即可答并新增 `engine_status`（loading/ready/failed）字段；引擎加载失败
  仍先 transport 后 `{type:"error"}`（宿主拿到诊断而非 malformed-message）。
  回归测试钉死该顺序：`test/helperDeferredEngine.test.mjs`（transport 先于引擎、
  health 立即可答、工具调用等引擎、失败先 transport 后 error）。
* **同批加固**：稳定端点指纹先 `path.normalize` 再哈希——启动器拼出的根带 `plugins\..`
  未折叠段（`%CONTAINER%\..` 派生），归一化前后必须同一个名字，宿主铸造与 agent 回落才不会分叉。
* **教训**：fail-closed 的"1s 准入线"没问题，问题是我把"transport"实现成了"引擎就绪"。
  两阶段握手的设计本来就写明了 transport 只代表"管道已绑"——实现违反了自己的契约。
  另外读**运行中进程的环境块**比任何日志推理都快：三个 app-server 全部 01:17:37 创建、
  env 里带着 UNAVAILABLE，一步定位。


## 六之一·补六：计算器会话（agent 自己跑通 6×7=42）抓出的产品缺陷（2026-10-11 凌晨）

修复竞态后的第一个真实 CU 会话里，agent 通过我们引擎完成了计算器 6×7=42（含截图人眼核对），
同时抓到两个产品层缺陷，均已修复并立判据：

1. **`key` 丢 pid**：helper 的 key 处理器只把 `key/modifiers` 传给引擎的 `press_key`，
   而真引擎与其它动作工具一样**必须带 pid**（运行时侧 resolveTarget+台账其实备好了 pid，
   是 helper 这一手丢的）→ 按键全部被拒。已修：pid + window_id（字符串→数值）+
   `delivery_mode` 透传；paste 的 hotkey 同样补上。判据：helperSemantics「key 把 pid/window_id
   透传给引擎」（回声假引擎 `test/fake-cua-driver-echo.mjs`）。
2. **S_OK 回执语义反向**：引擎对**成功的后台按键**返回 `isError:true` +
   「操作或完成。(0x00000000)」——0x00000000 是 HRESULT S_OK。不翻回来 assertEngineOk 就把
   成功当拒绝。已修：`engine/cua-driver.js#normalizeToolResult` 识别 S_OK 翻回成功并留痕
   （`engineSokCorrected:true`）。判据：test/engineAdapter.test.mjs（真拒绝如 0x80070005
   保持失败语义，绝不能误翻）。

会话还留下的**待办实证**（2026-10-11 凌晨第二轮：前两条已修完并真机验收，见 §六之一·补七）：

* ~~**截图回流断链**~~（已修，见补七）；~~**被遮挡/挂起的 UWP 窗口树为空**~~（已修，见补七）。
* agent 的探针与截图放在本机临时探针目录（不进仓，路径由开发者本地决定），排障时先看这里。

## 六之一·补七：截图回流 + app_ref 绑定面 + 透明激活（2026-10-11 凌晨第二轮，全部真机验收）

对照 SDK shim（绑定面）的真实消费逻辑修的三件事——修完真机复验：`app_ref{pid}` 一次调用
拿到 **42 元素 + 真计算器截图**（`shots/h-verify-backflow.png` 肉眼核对），离线 33/33、
真机验收 6/6。

1. **观察回执补 `app` 字段**：shim 的 `appStateOf` 要求回执**必须带 `app` 与 `window`**
   （缺哪个都抛 STRUCTURED_STATE_UNAVAILABLE "missing app"——绑定 API 首个观察就死在这）。
   `normalizeObservation` 现在从引擎的 `appName`+pid 构建 `app`；顺带把真引擎的
   `snapshotId` 映射成 `frame_id`（同一"帧权威"，坐标动作绑帧靠它）。
2. **截图回流**：引擎的 typed `getWindowState(includeScreenshot)` 本来就返回
   `images[{mimeType,dataBase64}]`，但 helper 把它丢了。现在 helper 把截图挂在回执的
   `screenshot` 字段 → runtime 抽出后作为 **MCP `content` 的 image 块**下发
   （shim 的 `imageBytesOf` 只认这个形状）；**base64 绝不进收据**——收据会以 JSON 文本块
   重复出现，塞进去同一张图要翻三倍。
3. **绑定面 app_ref 兼容 + 透明激活（两级）**：shim 的绑定 observe 只发
   `{app_ref, include_screenshot}`，app_ref 形态有 `{pid}/{window_id}/{name}` 与
   裸字符串（=bundle_id，shim 既定约定）。runtime 现在全部解析（按名走
   list_apps→pid→list_windows；查无此 app → APP_NOT_FOUND 且错误带名字）。
   上游把"启动与激活"并入 get_app_state（open_application 已删），我们同职责：
   **树为空时**才激活——①`bring_to_front`（win32 被遮挡通常够）；②仍空则按**窗口标题**
   `launch_app`（引擎自己把"计算器"解析成 AUMID，实测可用）——UWP 激活会**换新窗口**
   （真身挂在 ApplicationFrameHost 下），helper 跟随新窗口并把切换写进回执
   （`activated:true` + `[transparent-activation]` 告知块）。正常观察绝不抢焦点；
   kill switch 闩锁后连激活也停（有测试钉死）。
   * 注意：`bring_to_front`/`launch_app` 对 UWP 挂起窗口实测有先后依赖——先激活再截图，
     否则截到的是遮挡者的像素（实测复现过）。
   * 判据：helperSemantics（app 字段/snapshotId 映射、一级激活、二级激活跟随新窗口、
     kill switch 停激活）、runtime（app_ref 四形态 + APP_NOT_FOUND、image 块进 content
     且不进收据）、fake 引擎三件（echo/activate/uwp）。

## 六之一·补八：用户复测暴露的四缺陷（连开窗口 / key 参数错位 / target 不解包 / 后台 Invoke 空转）
（2026-10-11 凌晨第三轮，全部修复 + 离线 37/37 + 真机复验）

用户真机复测（agent 最终仍算出 6×7=42，但绕了大量弯路，且"开了非常多个计算器"）：

1. **透明激活级联连开窗口**：每次空树观察都 launch_app，而每次 launch 都开新窗口——
   模型反复观察旧窗口 = 反复开窗。修法（防级联三件套）：
   ①**激活记忆**：旧窗口 id → 接替新窗口 的映射（上限 32），再观察旧窗口**直接切过去**，
   不碰 launch；②**launch 冷却**：同标题 30s 内（`NIBI_CUA_LAUNCH_COOLDOWN_MS`）不重复激活，
   告知块写明"不再重复激活以免连开窗口"；③换窗必须记入映射。
   真机复验：连续两次 get_app_state 只开 **1** 个新窗口（第二次走记忆直切）。
2. **`key` 参数错位（"Empty key name"）**：shim 的 key 工具发 `{text}`，helper 只读 `{key}`
   → 引擎收到空键名。已修：`key`/`text` 双参数名 + `repeat` 循环（≤30）+ 空键名在 helper
   就明确拒绝（错误写清要什么）。
3. **点击目标两种标识都被拒**：shim 的统一 `target` 参数（数字=索引 / 字符串=token /
   `[x,y]`=坐标 / 对象）运行时没解包，直通后 helper 什么都拿不到。已修：resolveTarget
   解包四种形态（索引仍走台账新鲜度校验；token 直通交给引擎的快照校验；坐标走帧绑定）。
4. **后台 UIA Invoke 空转**（点击派发成功、effect_evidence 始终 unchanged、显示不动）：
   挂起/后台窗口不消费 UIA Invoke。已修：**输入动作前置前台**——动作前先 bring_to_front
   （回执带 `foregrounded:true`）；显式 `delivery_mode:"background"` 时不抢（尊重调用方意图）；
   前台化失败不拦动作，让动作如实汇报。
   判据：helperSemantics（key 双参数名+空键名拒绝、前置前台+background 豁免、激活记忆直切）、
   runtime（target 三形态落 helper + 坐标帧绑定）。

## 六之一·补九：交付模式与坐标空间的权威映射（2026-10-11 凌晨第四轮，真机探针定案）

用户第二轮复测（跑在 3:26 旧实例上——第三轮修复 3:50 才重启，时序错位）+ agent 全路径试错的
转写，暴露了四个**第三轮没覆盖**的契约缺口。先用引擎权威 schema（`listToolsJson`）+ 真机探针
把语义定案，再修：

1. **交付模式默认 foreground（上游产品策略 background=false 的同款决定）**。
   真机定案探针：`press_key{delivery_mode:"foreground"}` 一次落地（显示 8），
   `background` 派发成功但显示纹丝不动（UIA Invoke 对后台/挂起的 WinUI 空转）。
   helper 的 inputAction 现在默认 `delivery_mode:"foreground"`，调用方显式
   `"background"` 时尊重。上一轮的"输入前置前台 bring_to_front"被引擎原生交付取代
   （少一次往返、无 SetForegroundWindow 前台锁问题）。
2. **坐标空间两套，都要给模型并注明**：引擎元素带 `frame`（**屏幕**坐标）和
   `screenshot_frame`（**截图位图**坐标）——后者我们一直丢掉，模型只能自己换算屏幕/位图，
   真机换错两轮。`normalizeObservation` 现在两个都给；image_ref 的 note 写明
   "x/y 用截图像素坐标（与 screenshot_frame 同一空间）；frame 是屏幕坐标别混用"。
   （引擎 click 的 `scope` 默认 "window"≈位图相对坐标，正好与截图同空间。）
3. **click 参数映射**：shim 发 `mouse_button/click_count/modifiers`（复数），引擎要
   `button/count/modifier`（单数）——此前硬编码 left/1 且丢 modifiers（右键/双击/组合键
   全部静默变左键单击）。判据：helperSemantics「输入默认 foreground 交付」。
4. 验收纪律注记：真机验收套件对**残留窗口**敏感（白天十几轮测试留下的计算器实例会让
   "6×7" 找错窗口）——两个验收脚本按包脚本分开跑（它们本来就是两个命令）；跑前清掉
   CalculatorApp 残留进程。

## 六之一·补十：首次全绿实测（04:25，2 分 19 秒）+ 最后一个解包缺口（已修）

用户第三次实测**全绿**：2 分 19 秒算出 6×7=42，显示区与历史记录双重核对，agent 总结
"连上已开的窗口 → 读树 → 逐键点击"，无绕路、无多余窗口。它提到的两个摩擦点：
* "坐标点击前必须先带截图建帧，否则 STALE_STATE"——这是**设计内行为**（帧新鲜度），
  image_ref 的 note 已写明坐标空间；模型补一次截图即可。
* "索引点击被拒（报 Provide element_token or (x, y)）"——真缺口，已修：shim 的 bindTarget
  产出 `{type:"element", index}`，键名是 **index** 而非 element_index，target 解包没认它
  → 索引永远到不了引擎。已补 `index` 与嵌套 `frame_id` 的解包 + 判据
  （runtime「target 统一参数解包」新增 bindTarget 两种形态断言）。

## 六之一·补十一：687（Shift 缺陷）+ 闪烁问题 + 透明拉起合同（2026-10-11 清晨）

用户第四次实测：算式输成 **687**（`6 * 7` 的 `*` 落成了 `8`——主键盘 `*` 就是 Shift+8，
引擎 press_key 按字符注入时不带 Shift；探针实证 type_text("6*7=") → 42 正确）。
修法：**helper 的 key 路由**——可打印字符（数字/符号）走 `type_text`（Shift 语义正确），
键名（Return/Tab/F1/KP_1…字母开头）与含 `+` 的和弦走 `press_key`；回执带 `via` 说明走法。
判据：helperSemantics「key 路由」。

**闪烁与"不打扰操控"**（用户问：是不是 UWP 只能这样？）：
* 一闪一闪 = 每次输入的前台化（foreground 交付由引擎前置窗口）。对 WinUI/UWP（计算器、
  设置）这是**必须的**——它们挂起时不消费后台 UIA（真机实证）；普通 win32 应用大多支持
  后台 UIA，可以不打扰。产品面已暴露 `delivery_mode:"background"` 供模型选择。
* 本轮补齐自适应的**提示侧**：回执带 `delivery_mode`；**后台交付 + effect_evidence=unchanged**
  时追加 `[effect-unchanged]` 提示（"该应用可能只响应前台输入；若可安全重复，可显式
  foreground 重试"）。**不自动重试**——点击落地与否不确定，重放可能双触发（重试纪律）。
* 完全无闪烁的路线是自研 PiP/ghost-cursor 层 + 纯 UIA 后台驱动（无按键注入），在待办里。

**透明拉起合同补全**（按名绑定命中注册表条目的真机形态）：list_apps 里同一应用有两条——
运行中的 exe 条目（CalculatorApp.exe, pid=N）与注册表条目（"Windows 计算器", **pid=0,
running:false**）。此前按名命中注册条目 → list_windows({pid:0}) → 引擎 InvalidArguments。
现在：包含匹配（"计算器" ⊂ "Windows 计算器"）→ **优先运行中条目** → 只命中注册条目时
`launch_app`（helper 新后端，带 kill-switch 门 + 冷却）→ 按标题全窗口找 → pid+window_id。
修复过程中顺手钉掉：windowId 初始化为 null 而条件判 `=== undefined`（pid 永不赋值）。
判据：runtime「绑定面 app_ref」（含子串匹配、精确名）、helperSemantics launch_app 冷却。

## 六之一·补十二：PiP/ghost cursor 侦察结论（2026-10-11 清晨，time-box 定案）

**引擎自带的 agent cursor（上游 ghost cursor）在 Windows 上是死的**，探针证据链：
* `get/set_agent_cursor_enabled`、`set_agent_cursor_motion/style`（signature_arc 轨迹 +
  glow/ripple/squish 特效 + dwell_after_click_ms）、`move_cursor` 全部接受命令且返回成功；
* 但 `get_agent_cursor_state.enabled` **永远是 false**（enable 返回 true 后紧跟着读就是
  false，implicit 与显式 `start_session` 会话都一样）；`move_cursor` 后 `position` 正常更新
  到 (400,400)，桌面截图该位置**什么都没有**（含 2s dwell + trail 特效的形态）；
* 结论：命令面活着、渲染层不工作（或被 capture 排除且肉眼也未见）。不再投入。
* 另注意：`launch_app` 会重置 cursor 会话状态；元素数字键的 label 是中文数字
  （零一二…九、乘以、等于）——"7" 永远匹配不到，自动化按 label 找键要按本地化名。

**自研 ghost cursor overlay 的设计（下一轮实施，已有全部地基）**：
1. Helper 的输入回执带 `action_position: {x, y}`（inputAction 解析目标时已知：
   element→frame 中心 / 坐标原样；屏幕坐标空间）。
2. 传输：host→main 已有 cuaOperationStateReporter 通路（pill 的事件流），加一个带坐标的
   动作事件（协议小改，注意三处投影：services/desktop/UI）。
3. 桌面端：`windowsCuaGhostCursor.ts` —— 复用 windowsCuaOperationIndicator 的成熟模式
   （透明置顶 + data-URL HTML + CSP），48px 光标贴图在 (x,y) 做 300ms 淡出动画；
   click-through（鼠标事件穿透，SetWindowLong WS_EX_TRANSPARENT | LAYERED）。
4. 交付模式联动的最终形态：后台交付成功 → 光标动画照画（不打扰 + 可视化兼得）；
   foreground 交付 → 引擎前置本身就有反馈，光标叠加不冲突。

## 六之一·补十三：自研 ghost cursor overlay（2026-10-11，已实现并全链验证）

引擎自带的 cursor 管线在 Windows 上渲染层不工作（补十二已判死），所以自研。**全链已打通**
（逐跳日志实证）：

1. **helper 计算坐标**：观察时缓存 `window_bounds`（屏幕坐标 {x,y,width,height}）与元素
   token→frame 中心；输入动作时换算——元素走 frame 中心（已是屏幕坐标）、栅格 x/y 按
   `bounds + x*(width/shotW)` 换算；键盘类无目标不求坐标。经既有 IPC 通道发
   `{protocol, type:"action_position", x, y}`（与 transport_ready/ready 同通道）。
2. **宿主解析转发**：`parseActionPosition`（services，含判据 `cuaActionPosition.test.ts`）
   → `onActionPosition` → `cuaOperationStateReporter` 同款通路 → `parentPort.postMessage
   {type: CuaActionPosition, x, y}`（新增 channels 枚举 + validation schema，进 host 响应 union）。
3. **桌面主进程**：`windowsCuaGhostCursor.ts`（透明置顶 64×64 + data-URL HTML + CSP、
   鼠标穿透 `setIgnoreMouseEvents(true)`、`showInactive`/`moveTop`、物理像素→DIP 换算按显示器
   scaleFactor、680ms 淡出动画后自动隐藏、`ownsWindow` 参与主窗口过滤、退出 dispose）。
   主进程 dispatch 分支 `HostResponseTypes.CuaActionPosition → showAt(event)`。

**修过的两个真 bug**（都是这轮调试暴露的）：
* dispatch 里的诊断日志用了不在作用域的 `logger` → **每条 host 消息触发一次主进程异常**
  （用户可见两张 "A JavaScript error occurred in the main process" 对话框）。教训：往
  热路径插日志前先确认作用域里的 logger 名（本文件用 `dependencies.logger`）。
* helper 清调试残留时切掉一个 `)`，语法错误。

**验证证据**：三跳日志逐跳确认（helper emit → host reporter posting → main dispatch
got action_position），点击全部 `isError:false`，计算器显示值随点击变化。窗口本身在
Electron 内创建/显示已单独验证（离屏脚本 results.created=true）。
**待用户肉眼确认**：真实操控时目标位置是否闪现圆环（视觉效果只有真机可见）。

## 六之一·补十四：UWP 跨 pid 绑定 + 完全访问引导（2026-10-11）

**A. UWP 跨 pid 绑定**（用户在实测转写里报的真缺陷：`Windows 计算器`/bundle_id 都提示
"没有匹配到运行中的应用"，pid 又提示"没有可见窗口"）。真机探明承载形态：

* packaged 应用的**窗口挂在 ApplicationFrameHost.exe 名下**（和 app 进程不同 pid），
  且注册条目 `pid=0, running:false`、`launch_path=shell:appsFolder\<pfn>!App`；
* 修法三件：①`launch_app` 支持 `launch_path`（helper+运行时都传）；②**先看是不是已开着**
  ——按窗口标题双向包含匹配（窗口标题常是短名"计算器"，注册名是"Windows 计算器"，
  单向 `title.includes(wanted)` 必漏）直接绑既有窗口；③确实没开时才 launch，
  并用**窗口增量检测**（启动前后 id 差集，UWP 冷启动实测 ~1.2s 内出现新窗口）绑定，
  不依赖 pid 关系。
* 判据：runtime「UWP 跨 pid 绑定」「UWP 已运行」两条（fake 加 `FAKE_UWP_MODE` /
  `FAKE_UWP_ALREADY_RUNNING`）。真机验证：「Windows 计算器」与「计算器」两个名字
  都一次绑到 AFH 的 pid + 42 元素。

**B. 完全访问引导**：Windows 上 CUA 没有系统授权门槛（那是 macOS TCC），用户遇到的是
**工具审批**——`mode==="yolo"`（完全访问）在权限服务里直接放行，`build`（变更前确认）
则每次调用都要点允许。产品策略是**只提示不越权**（改权限模式是用户决定）：
新增 `V4ComposerCuaFullAccessHint`（挂输入框上方，复用 `useCuaComposerEntry` 的可见性判据
避免判定漂移），非 yolo 模式时显示一条提示 + 「切到完全访问」按钮（调 composer 现成的
`onSwitchMode("yolo")`）+「不再提示」（写入 `settings.computerUseFullAccessHintDismissed`）。

## 六之一·补十五：系统壳窗口绝不可被绑成目标（2026-10-11 用户实测事故）

**现象**：用户实测时"打开了一个不是计算器的窗口"，且模型自述"绑定计算器时意外捕获到
一个 LockApp 窗口（元素树为空）"，随后多开了应用窗口、绕两轮才自己回到正常路径。

**根因**（读原始转写 + 复现应用列表后定案）：
1. 按名绑定计算器时，`list_apps` 里该应用是**注册条目**（`pid=0, running:false`），
   而**系统里其实已有计算器窗口**——走"拉起 → 等新窗口"这条路径；
2. 拉起那一步的候选解析失败（名字/launch_path 未命中），而窗口增量检测里有
   **"唯一新窗口就采纳"的宽松兜底** → 把**锁屏窗口**（LockApp.exe，标题"Windows 默认
   锁屏界面"）当成了目标；
3. 锁屏窗口的 UIA 树必然为空 → 触发透明激活 → 在一张**系统级 UI** 上白跑，
   并在回执里把 `app` 写成了锁屏进程名（模型看到 `app: {name: "LockApp.exe"}`）。

**修法**（两条判据，都是"宁可不绑也不绑错"）：
* **系统壳黑名单**：`LockApp`/`AssignedAccessLockApp`/`ShellExperienceHost`/`SearchApp`/
  `StartMenuExperienceHost`/`TextInputHost`（含 `Microsoft.*` 变体）**永不作为绑定目标**
  ——应用候选与窗口候选两侧都过滤；窗口侧另有标题判据（"默认锁屏/锁屏界面/lock screen"）；
* **删掉"唯一新窗口"兜底**：窗口增量必须**有标题证据**才采纳（标题与查询名/注册名
  双向包含）。没有证据就这一轮找不到，交给既有窗口兜底或如实报错——不猜。

判据：runtime「系统壳拒绝：锁屏窗口绝不被绑成目标」（fake 加 `FAKE_UWP_SHELL_FRESH`，
故意让"唯一新窗口"是锁屏）。真机复验：绑定「计算器」→ AFH pid + 42 元素，未误绑。

## 六之一·补十六：ghost cursor 长驻优化 + 陈旧窗口候选（2026-10-11）

**A. 长驻优化**：旧实现每次动作都 `loadURL`（整份 data-URL 文档重新解析）只为重放 CSS 动画
——高频点击时每次多一次文档加载。现在：文档**只加载一次**，动作用
`executeJavaScript` 走"移除 .play → 强制回流 → 重新加类"的标准动画重启；
`did-finish-load` 置 `pageReady`，首个动作若早于文档就绪则由它补放一次。
顺带把 electron 改成**延迟加载**（`require` 在用时取），模块因此可在非 electron 环境被
离线测试 import。判据：`packages/desktop/test/windowsCuaGhostCursor.test.mjs`（3 项：
第二次动作不再 loadURL / 复用同一窗口实例 / DPI 换算）。

**B. 陈旧窗口候选**（真机验证时发现的残余）：按名绑定有多个标题匹配候选时，
可能选中一个**元素树恒为空的陈旧窗口**（真机实证：旧的锁屏窗口标题也是"计算器"，
绑上去拿到 0 元素）。修法：候选**逐个观察**，挑**元素树非空**的那个（多一次观察换绑对）。

**C. 交付模式与前台锁**（同时确认的既有行为，非缺陷）：foreground 交付要求目标窗口真的
在前台，Windows 前台锁会拒绝——`foreground_unavailable: Windows did not activate exact
target HWND`。此时**不发送鼠标事件**（引擎的正确防护）。要"不抢焦点"就用
`delivery_mode:"background"`（真机复验：连点 5 次全部成功、不抢前台）。

## 六之一·补十七：租约必须会过期（2026-10-11 真机事故，最严重的一条）

**现象**：用户实测时 agent 报 `CONTROLLER_BUSY: 输入正在被另一个会话占用: pipv`，
**6×7 完全没算出来**——任务彻底失败。

**根因（我的缺陷，比"备份窗口"严重得多）**：
* `pipv` 是**调试脚本用过的会话**（我为验证"不抢焦点"路径用 `delivery_mode:"background"`
  连点了 5 次）。脚本退出时**没有释放输入租约**；
* 而租约实现**永不过期**（`acquireInputLease` 只写 `{sessionId, at}`，`at` 从未被读）。
  于是那个残留租约把所有后续会话永久挡在门外，**没有任何自动恢复路径**——
  用户只能眼看任务失败，也无从知道该"关掉哪个会话"（那个会话早就不存在了）。

**修法**：租约加**空闲过期**（默认 90s，`NIBI_CUA_LEASE_IDLE_MS` 可覆盖）——
`status()` 与 `acquireInputLease()` 都先跑 `expireIdleLease()`。语义澄清：输入租约是
"谁在操作"的**活跃期互斥**，不是永久所有权；超过空闲窗口没有新动作就自动释放，
让下一个会话接管。90s 远大于单次动作间隔（秒级），不会误伤正常连续操控。
判据：helperSemantics「租约空闲过期：残留租约不再永久锁死后续会话」（压缩到 150ms 验）。

**附带澄清**：用户截图里的「Windows 备份 / 你所在的国家或地区尚未提供此功能」窗口
**不是我们打开的**——读该次会话完整转写，没有任何调用命中它；它只是被 agent 的截图
**看到**（该窗口是 ApplicationFrameHost 承载的独立 UWP 窗口，与计算器同宿主，
launch 候选与窗口候选都未涉及它）。

## 六之一·补十八：长驻优化的两个回归（2026-10-11，我引入的）+ 同名窗口选择

用户复测："成功了，但**没有操作的时候不闪蓝光了**"。

**A. ghost 光标静默失效（长驻优化引入的回归）**：为让模块可离线测试，我把 electron
改成延迟加载，连写错两次——
1. `new loadElectron().BrowserWindow(...)`：JS 解析成 `new (loadElectron())`
   → `loadElectron is not a constructor`；
2. 改用 `require("electron")`：主进程 bundle 是 **ESM** → `Dynamic require of "electron"
   is not supported`。
两次都**静默失效**（只打一条 warn，用户只看到"不闪了"，没有任何界面提示）。
修法：electron 依赖隔离到 `windowsCuaGhostCursorElectron.ts` 适配层（单一接触点），
纯几何抽到 `windowsCuaGhostCursorGeometry.ts`（无 electron，可离线测）。
判据：`packages/desktop/test/windowsCuaGhostCursor.test.mjs` 的**源文件静态扫描**
（禁止 `require("electron")` 与 `new f().BrowserWindow(` 两种写法 + 断言 loadURL 只出现一次
= 长驻不变量）。真机复验：create failed = 0，4 次点击全成功。

**B. 同名窗口选错**：桌面上有两个计算器窗口（真机 2026-10-12），按名绑定选中了**非前台**
那个，随后 foreground 交付被前台校验拒绝（`目标窗口不在前台`），模型只能自己重绑。
修法：候选**按 z_index 降序**排（引擎 window 列表无 focused 字段，但前台窗口 z_index 最高）。
判据：runtime app_ref 用例（既有）+ 真机复验绑到前台窗口。

## 六之一·补十九：拆除 ghost cursor（产品决策）+ perform_action target 解包（2026-10-12）

**A. 拆除 ghost cursor（用户决策）**。用户判断："这个蓝光层没什么用，主要是给人看的，
还占内存、不好维护；能正常操控 + 有「NIBI 正在操作电脑」提示就够了。" 采纳并**全链拆除**：
删 `windowsCuaGhostCursor{,.Electron,.Geometry}.ts` + 两个测试；移除 helper 的观察缓存 /
坐标换算 / IPC 上报、宿主解析与 `onActionPosition`、services 选项透传、`shared` 的
`CuaActionPosition` channel + schema、main 的 dispatch 分支与窗口实例。
保留：`cuaOperationStateReporter` 驱动的**操作提示条**（NIBI 正在操作电脑，含鸟头图标）。

复盘（为什么这次投入产出比失衡）：
* 长驻优化期间我**连写错三处 Electron API 用法**（`new f().BrowserWindow(...)` 构造器误用、
  `require("electron")` 在 ESM bundle 不可用、`win.executeJavaScript`/`win.on("did-finish-load")`
  挂错对象），三处都会让光标**静默失效**（只打 warn，界面无提示）；
* 而"是否看得见"的**验证手段**在真机上都不可靠：抓屏有 600ms 级延迟与撕裂伪影，
  颜色/环形启发式被 NIBI 文字抗锯齿、系统蓝图标反复误判（我一度把「Windows 备份」的
  感叹号当成光标）。
* 结论：**这类纯装饰层，收益（看一眼）与成本（跨 4 层协议 + 3 处 Electron API 陷阱 +
  不可靠的自动验证）不成比例**。产品决策正确。

**B. `perform_action` target 解包（模型自己排查出来的真缺陷）**：绑定面 `performSecondaryAction`
发 `target:{type:"element", index}`，而运行时该校验块跑在 `resolveTarget` **之前**、直接读
顶层 `params.element_index` —— 校验永远找不到元素，报"需要元素 index"，模型只能绕到底层
`computer.perform_action({element_index})` 才能点按键（截图转写里它明确指出了这一点）。
已修：校验前在同一处解包 target（数字 / 对象 / 顶层三种形态）。

## 六之一·补二十：租约未随 turn 结束释放（2026-10-12 用户双会话实测发现）

**现象**（用户实测，两个会话并测）：会话 A 用电脑操控算出 42 后，租约仍挂在 A 上；
用户开新会话 B 做同样任务，被 `CONTROLLER_BUSY: 输入正在被另一个会话占用: sess_58c245d8…`
挡住，**模型只能提示用户"去关掉那个会话"**——体验上等于"上一个任务做完后，下一个任务
要等 90 秒或手动干预"。

**根因**：租约只在两个时机释放——①会话显式 `closeSession`；②**空闲 90 秒过期**（补十七加的）。
但"turn 结束（任务完成）"这个信号**没有接到释放上**：`cuaOperationTurnTracker` 已能感知
`onTurnsIdle`（"went idle"），该回调也已存在，只是没有接线到 helper 的 `release_input_lease`。

**已备好的半成品**（下次接着做）：
* helper/semantics 已有 `forceReleaseInputLease()` + `release_input_lease{force:true}`
  （宿主侧可信收口，不校验持有者）—— 判据待补；
* tracker 的 `onTurnsIdle` 回调待接线：`nibiAgentService` 创建 tracker 处传入回调 →
  经 `cuaOperationStateReporter` 同层的通道到桌面主进程 → 调 helper 的
  `release_input_lease{force:true}`。
* 为什么没有当场做完：这条要在 services → desktop main → helper 三层加新接线，
  而 90 秒空闲过期已能兜住（用户重试同一任务时只要等一会），故按"记缺口、不阻塞"处理。

## 六之一·补二十一：租约随 turn 结束释放（2026-10-12，用户双会话实测的缺口，已修完）

补二十记录的缺口已闭合。链路（三处新增）：

1. **helper**：`semantics.forceReleaseInputLease()` + `release_input_lease{force:true}`
   —— 不校验持有者（宿主是可信侧，turn 生命周期是权威信号）；非 force 时保持原语义
   （持有者不匹配不动租约，有判据）。
2. **Windows host**：`WindowsCuaHelperHost.releaseInputLease()`
   —— 用 `callBrokerMethod` 发 force 释放，失败只 warn（不能因收口失败影响 turn 结束路径）。
3. **接线**：`createZCodeAgentService` 新增 `onCuaTurnsIdle` 选项 → 透传给
   `cuaOperationTurnTracker` 的 `onTurnsIdle`（该回调本就存在，此前无人接）→ node.ts 里
   懒查 `defaultCuaProductHelperLifecycle.peek()` 拿 host 并调 releaseInputLease。

判据：helperSemantics「force 释放：宿主 turn 结束可无条件收回租约」（含 A 拿租约 → force
释放 → B 立刻接手 → 非 force 不动租约 四段断言）。离线 43/43，四处 typecheck 全过。

## 六、已知风险 / 待办

* macOS 的 TCC 归属：嵌入门路要求"授权挂在我们的责任应用上"，发布前要用真机验一次
  （`@trycua/cua-driver/electron` 提供 `requestMacOSPermissions` / `hasRequiredMacOSPermissions`）。
* Windows 后台部分动作上游是**精确拒绝**（`background_unavailable`）：运行时要把这类拒绝翻成
  结构化错误（已有 fail-closed 语义），不要升级成"抢前台偷偷做掉"。
* 版本钉死：`@trycua/cua-driver` 具体版本 + 平台包 sha256 记进 NOTICE；升级走"重跑 P1 测试 + 真机冒烟"。
* `@ubjs/*`（MPL-2.0）只随包分发、不改动；我们自己的代码不引入 MPL 文件。
