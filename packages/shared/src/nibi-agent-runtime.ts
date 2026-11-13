export type NibiAgentBinaryKind = "native-binary";

export interface NibiAgentRuntimeDescriptor {
  binaryKind: NibiAgentBinaryKind;
  binaryEnvVar: string;
  /** 本地随包目录（resources/<dir>、bundled-agents/<platform>/<dir>、远端 agents/<dir>）。 */
  bundledResourceDir: string;
  /** 旧 R2 组件归档内的挂载目录；R3 Source Server 的 descriptor/archive 不使用它。 */
  resourcePackageDir: string;
  version: string;
  spawnArgs: string[];
  nativeConfigDir: string;
  nativeConfigFileName: string;
  missingBinaryMessage: string;
  resolveEntrySegments(platform: string): string[];
  /**
   * 桌面端把 agent 的 JS bundle（nibi.cjs）打进 resources/nibi，由 app 内置的 Electron Node runtime
   * （ELECTRON_RUN_AS_NODE）直接执行，避免再随包内置一份独立 Node 二进制。
   * 这里只放纯 JS 入口文件名，平台无关（与 resolveEntrySegments 的原生二进制路径平行）。
   */
  nodeBundleEntryFile: string;
  resolveNodeBundleSegments(): string[];
}

export function resolvePlatformBinaryName(binaryName: string, platform: string): string {
  return platform === "win32" ? `${binaryName}.exe` : binaryName;
}

export const NIBI_AGENT_RUNTIME: NibiAgentRuntimeDescriptor = {
  binaryKind: "native-binary",
  binaryEnvVar: "NIBI_AGENT_BINARY_PATH",
  bundledResourceDir: "nibi",
  resourcePackageDir: "glm",
  version: "0.13.3",
  spawnArgs: ["app-server", "--stdio"],
  nativeConfigDir: ".nibi/cli",
  nativeConfigFileName: "config.json",
  missingBinaryMessage:
    "[NIBI Agent] agent binary 未找到，请设置 NIBI_AGENT_WORKDIR、NIBI_AGENT_BINARY_PATH 或先准备 NIBI Agent 运行时资源",
  resolveEntrySegments: (platform) => [resolvePlatformBinaryName("nibi-agent", platform)],
  nodeBundleEntryFile: "nibi.cjs",
  resolveNodeBundleSegments() {
    return [this.nodeBundleEntryFile];
  },
};

export function getNibiAgentRuntime(): NibiAgentRuntimeDescriptor {
  return NIBI_AGENT_RUNTIME;
}
