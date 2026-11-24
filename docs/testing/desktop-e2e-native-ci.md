# Desktop E2E native CI（macOS / Windows）

`.github/workflows/desktop-e2e-native.yml` 在 macOS 与 Windows 宿主机上运行桌面 Electron E2E，
用于满足插件准入规则 6：「已准入 preset 除 Linux 外，还必须由 macOS 与 Windows CI 选中同一份
formal spec 集」。它不启动 Docker，也不访问真实模型上游。

## 触发方式

两条入口，都只覆盖 verified preset：

1. **dev push 自动触发**：仅当 `scripts/test-desktop-e2e-container.sh`（preset 常量）或本
   workflow 自身变化时运行，跑 `plugins` 集合。普通代码推送不会消耗 macOS runner。
2. **`workflow_dispatch` 手动触发**：选择 `targets`，用于定点复跑或跑会话域。

> `workflow_dispatch` 只有在 workflow 已存在于默认分支 `main` 时才可调度；在它进入 `main`
> 之前，dev 上的 push 触发是唯一能起首跑的入口。合并到 `main` 后两条入口都可用。

手动触发时选择 `targets`：

| `targets`              | 运行集合                                                                 |
| ---------------------- | ------------------------------------------------------------------------ |
| `plugins`（默认）      | `plugins-verified` preset，当前 11 条已转正并完成 Docker 准入的插件 spec |
| `conversation-session` | `conversation-session-verified` preset，当前 4 条会话 spec（含 WPL-015） |
| `all-verified`         | 上述两个 preset 的并集                                                   |

## Spec 集的唯一事实源

workflow 不维护第二份 spec 清单，而是调用容器脚本打印 preset：

```bash
bash scripts/test-desktop-e2e-container.sh --print-spec plugins-verified
bash scripts/test-desktop-e2e-container.sh --print-spec conversation-session-verified
```

`--print-spec` 只解析 preset 并打印逗号分隔的 spec 列表，随后退出；它不检查 Docker，也不启动容器。
因此 Linux 容器 preset 与 macOS/Windows native CI 永远选同一份集合；新增准入 spec 时只改
`scripts/test-desktop-e2e-container.sh` 里的常量。

## 运行内容

1. 安装依赖（`scripts/pnpm-install-ci.sh`）。
2. 构建 debug Rust 内核：`cargo build --locked -p nibi-kernel-cli --bin nibi-rs`。
   WDIO `onPrepare` 只消费已构建的内核二进制，桌面本地 Agent 没有 Node 回退。
3. 构建 `@nibi/e2e-report`，然后由 `onPrepare` 构建桌面 app。
4. 以 replay 模式运行 WDIO：

   ```bash
   E2E_PROVIDER_HTTP_MODE=replay \
   NIBI_E2E_SPEC="<preset 打印结果>" \
   pnpm --filter @nibi/desktop exec wdio run wdio.conf.ts
   ```

5. 上传 `packages/desktop/.e2e-artifacts/`（7 天保留）。

## 状态口径

- 覆盖矩阵里 macOS CI / Windows CI 两列在首次实跑通过前记 `selected`，不记 `verified`。
- 首次运行流程：dev push 自动触发（或手动 dispatch `targets=plugins`）；两个平台都通过后，把
  [plugin-management-lifecycle-e2e-coverage-matrix.md](./plugin-management-lifecycle-e2e-coverage-matrix.md)
  中 `PLM-LC-001..010` 的两列改为 `verified`，并在该矩阵记录 macOS 与 Windows 的 run id。
- 任一平台失败时按真实平台问题排查，不得用跳过、`continue-on-error` 或缩小 spec 集掩盖；
  未通过就保持 `selected`。

## 边界

- 只运行 verified preset，不收集 `manual-review/pending`。
- 不替代 Linux `replay-isolated` 容器准入，也不替代手机 `/remote` 的 replayable 回归。
- macOS 与 Windows 的并行策略以矩阵默认值为准（两个平台各一个 job）；如果后续要扩成 shard，
  仍必须使用同一份 `--print-spec` 结果做并集校验。
