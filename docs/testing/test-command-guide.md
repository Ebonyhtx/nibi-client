# 日常测试与类型检查命令指南

这一页回答一个问题：改完代码后，这一轮该跑哪条命令，能省多少时间。

测量环境（2026-11-11）：Windows 10、AMD Ryzen 7 5700G（16 vCPU）、32 GB 内存、
Node 24.22.2、Vitest 4.1.4。数值会随机器负载波动，看量级即可。

## 命令矩阵

| 场景                      | 命令                                                                | 实际覆盖                                                                         |
| ------------------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 日常每轮改动              | `pnpm test:unit:changed`                                            | HEAD 的未提交改动（staged + unstaged + untracked）经 Vitest 官方依赖图选中的测试 |
| 只迭代某一个包            | `pnpm test:unit:changed --package services`                         | 在上一行选中结果里再收窄到指定包；**只用于本地迭代，不是门禁**                   |
| 先看会跑哪些文件          | `pnpm test:unit:changed --dry-run`                                  | 不执行测试，列出精确文件清单                                                     |
| 针对显式文件              | `pnpm test:unit:changed --files <path...> --dry-run`                | 官方 related 选择；lint-staged 也走这条路径                                      |
| 提交前（pre-push 自动跑） | `pnpm verify:pre-push`                                              | 静态检查 + `test:unit:affected --scope push`（推送范围全部受影响测试）           |
| 发版前 / 大改后           | `pnpm test:unit`                                                    | 全量单测（1,985 个文件，排除 desktop E2E）                                       |
| 类型检查                  | `pnpm typecheck`                                                    | `tsc -b` 16 个工程 + 5 个独立 `tsc -p --noEmit` 工程                             |
| 低内存 / 排查类型检查问题 | `pnpm typecheck:serial` 或 `TYPECHECK_CONCURRENCY=1 pnpm typecheck` | 与 `pnpm typecheck` 完全相同的工程，只是串行执行                                 |

`pnpm test:unit:changed` 与 `pnpm test:unit:affected` 共用同一份实现：
前者等价于 `--scope worktree`，默认只比较 HEAD 与本地未提交改动；后者额外支持
`--scope push`、`--base <commit>` 和 lint-staged 的 `--files-manifest`。

`--package` 只收窄执行集合，不参与“是否全量选择”的判定；`--scope push` 与
`--package` 混用会直接报错（exit 2），防止把推送门禁悄悄跑窄。

两条入口都会打印实际选中的文件数、选择耗时和执行耗时。选中 0 个文件时会额外
输出 `判据空转` 警告：exit 0 只表示“没有测试需要跑”，不表示改动已验证。

## 实测耗时

| 项目                       | 实测                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| 全量单测规模               | 1,985 个文件；历史记录 18,488 条通过 / 76 skipped                                                    |
| 全量 `pnpm test:unit`      | 未在时间盒内直接跑全量。以 services 包 247 个文件 103 s 外推约 14 min（仅量级参考）                  |
| 定向选择（固定成本）       | 60–80 s：Vitest 要转换全部 1,985 个测试文件来构建依赖图                                              |
| 单文件改动的选中数示例     | `gitService.ts` → 97/1985；`stateStorage.test.ts` → 1/1985；无测试引用的 UI 文件 → 0（会警告）       |
| 定向执行示例               | 只改一个测试文件：选中 1 个，总计 63.9 s；改高扇入源码 `stateStorage.ts`：选中 98/1985，执行 143.9 s |
| `pnpm typecheck`（热缓存） | 15.5 s → **8.6–9.6 s**（`tsc -b` 4.6 s + 5 个独立工程并行 4.0 s；串行时 10.7 s）                     |
| `pnpm typecheck`（冷缓存） | 约 120 s（`tsc -b --force` 116 s + 独立工程 4 s）                                                    |
| `maxWorkers` 4 vs 8        | services 247 个文件：103.4 s vs 101.2 s（约 2%），因此保持 4                                         |

日常一轮的典型成本从“十几分钟全量”降到“1–2 分钟定向”（选择 60–80 s + 实际测试），
类型检查再省 6–7 s。改动面覆盖全量规格时，脚本仍会拒绝静默放行，要求先跑
`pnpm test:unit`，再用 `NIBI_AFFECTED_UT_ACK=full` 重跑本入口。

## 已知取舍

- **没有调高 `maxWorkers`**：4 → 8 实测只有约 2% 收益，配置里的注释也记录了低配机
  并发过高会打穿 5 s/30 s 超时；CI 本身已用 `--maxWorkers=2` 分片。需要临时加速可用
  `pnpm test:unit --maxWorkers=8`，不改默认值。
- **没有合并重复的类型工程**：`tsc -b` 的 desktop main/host/e2e 与 5 个 `tsc -p`
  之间存在源码重叠（main∩host 88、main∩remote-main 95、host∩remote-main 77、
  main∩e2e 18、host∩e2e 21、e2e∩remote-main 18、main∩renderer 4、main∩preload 3）。
  `remote-main` 的 95 个源码文件全部已包含在 main 里，它存在的意义是用无 DOM 的
  lib 再严格检查一遍；消除这些重复要改 `packages/desktop/tsconfig.*.json` 或放弃
  某套 lib 检查，属于本次脚本优化之外的改动。当前先把 5 个独立工程并行，覆盖范围
  不变。
- **没有给 `scripts/run-tests.mjs` 增加受影响包模式**：它是旧的 `node --test` 入口，
  CI 与 pre-push 都不使用；受影响选择统一由 Vitest 官方入口完成，避免维护两套
  选择逻辑。确实只想跑某个包时，`pnpm test:unit -- packages/services` 即可。
- **类型检查并行的内存代价**：并发 4（8 核及以上默认）实测额外峰值内存约 1.9 GB
  （4 个 tsc 进程，32 GB 机器采样）；低内存机器用 `pnpm typecheck:serial` 或
  `TYPECHECK_CONCURRENCY=1`/`2`。
- **没有启用 `experimental.fsModuleCache`**：实测选择阶段 79.8 s → 73.0 s，没有实质收益
  （选择成本主要在解析依赖图，不在重复 transform），因此不引入这个实验特性。
- **Windows 路径修复**：Vitest 的 `spec.moduleId` 用正斜杠，而 `related` 依赖路径
  用反斜杠。修复前 `--files <一个 test.ts>` 在 Windows 上选中 0 个（判据空转），
  修复后选中该文件本身；选择规则没有放宽。
