/**
 * windows-runtime-host 标准调用示例：Host 启动 agent 时照此顺序安装监听、start、close。
 */
import type { WindowsRuntimeHost } from "#src/windows-runtime-host/contract.js";

export async function exampleWindowsRuntimeHost(runtime: WindowsRuntimeHost): Promise<void> {
  runtime.onRootExit(() => {
    /* 根退出不能释放 Job 所有权；清理仍必须走 close。 */
  });
  await runtime.start();
  await runtime.close(Date.now() + 3_250);
}
