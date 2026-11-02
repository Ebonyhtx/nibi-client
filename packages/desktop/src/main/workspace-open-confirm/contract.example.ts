/**
 * desktop-workspace-open-confirm 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type {
  WorkspaceOpenConfirmContract,
  WorkspaceOpenConfirmCopy,
} from "./contract.js";

/**
 * 运行中收到外部 `nibi://workspace/open` 时，先确认再做任何目录探测/打开。
 * `undefined` 表示品牌化窗不可用，调用方必须回退原生 `confirmExternalWorkspaceOpen`。
 */
export function exampleDesktopWorkspaceOpenConfirm(
  contract: WorkspaceOpenConfirmContract,
  parent: unknown,
  path: string,
  copy: WorkspaceOpenConfirmCopy,
): Promise<boolean | undefined> {
  return contract.confirm({ copy, parent, path });
}
