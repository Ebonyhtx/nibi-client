import {
  NIBI_AGENT_RUNTIME,
  NIBI_AGENT_PROVIDER,
  NIBI_AGENT_REMOTE_COMPONENT_FALLBACK_ID,
  NIBI_AGENT_REMOTE_COMPONENT_IDS,
  selectNibiAgentRemoteComponentId,
  type NibiAgentRemoteComponentId,
  type RemoteResourcePackageId,
} from "@nibi/shared";
import type { IRemoteBackend, RemoteEnvironment } from "@nibi/server/remote/backend.js";
import {
  REMOTE_BASE,
  type DeployLoggers,
  type RemoteAssetDeployOptions,
  waitForClose,
} from "@nibi/server/remote/deployShared.js";
import type { RemoteAssetInstaller } from "@nibi/server/remote/remoteAssetInstaller.js";
import { buildWriteLiteralFileCommand } from "@nibi/server/remote/posixShell.js";
import { deployDevelopmentNibiAgentRuntime } from "@nibi/server/remote/nibiAgentDevDeploy.js";
import {
  buildRemoteAgentBundleWrapper,
  isRemoteAgentBundleWrapperCurrent,
  REMOTE_AGENT_BUNDLE_NAME,
} from "@nibi/server/remote/nibiAgentBundleWrapper.js";
import {
  deployRemoteAgentWrapper,
  isWslBackend,
} from "@nibi/server/remote/nibiAgentWrapperDeploy.js";
import {
  buildRemoteAgentOfficialPluginDir,
  buildRemoteAgentOfficialPluginRequiredPaths,
  buildRemoteAgentOfficialPluginSourceRelativePath,
  REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS,
} from "@nibi/server/remote/nibiAgentOfficialPluginAssets.js";
import { repairLegacyRemoteOfficialPluginDirectoryPermissions } from "@nibi/server/remote/nibiAgentOfficialPluginPermissionRepair.js";
import {
  checkRemoteAssetComponentIdentity,
  writeRemoteAssetComponentMeta,
} from "@nibi/server/remote/remoteAssetLiveIdentity.js";

const REMOTE_AGENT_RUNTIME_BASE = `${REMOTE_BASE}/agents`;

export interface DeployNibiAgentRuntimeOptions extends RemoteAssetDeployOptions {
  platformArch: string;
  installer: RemoteAssetInstaller;
  selectedResourcePackageIds?: RemoteResourcePackageId[];
  force?: boolean;
  /** 已由 deployServer 根据 manifest 解析出的组件 id；直接调用时可省略。 */
  componentId?: NibiAgentRemoteComponentId;
  /**
   * 当前 manifest 实际发布的组件 id。null 表示 manifest 不可用（旧 mock-cdn /
   * 历史本地 release），此时沿用旧 id 以保持 4.1.3 时代行为。
   */
  resolvePublishedComponentIds?: () => Promise<readonly string[] | null>;
}

function isNibiAgentPackageSelected(
  selectedResourcePackageIds: readonly RemoteResourcePackageId[] | undefined,
): boolean {
  if (!selectedResourcePackageIds) {
    return true;
  }
  return NIBI_AGENT_REMOTE_COMPONENT_IDS.some((componentId) =>
    selectedResourcePackageIds.includes(componentId),
  );
}

/**
 * 选择本次部署实际使用的 Nibi Agent 组件 id。
 *
 * 规则：
 * 1. 资源包选择里既没有新 id 也没有旧 id → 跳过（调用方明确没选 agent）。
 * 2. manifest 明确发布 `nibi-agent` → 新 id；只发布 `glm` → 回退旧 id。
 * 3. manifest 可用但两个 id 都没有 → 抛错，不能静默跳过（否则远程会话会在
 *    没有 agent 的情况下“连接成功”）。
 * 4. manifest 不可用（历史 mock-cdn / 本地 release 没有 manifest）→ 沿用旧 id，
 *    保持 4.1.3 及以前的行为；后续 installFile 仍会因缺文件 fail-closed。
 */
export async function resolveNibiAgentRemoteComponentId(
  options: {
    selectedResourcePackageIds?: readonly RemoteResourcePackageId[];
    resolvePublishedComponentIds?: () => Promise<readonly string[] | null>;
  },
  loggers: DeployLoggers,
): Promise<NibiAgentRemoteComponentId | null> {
  if (!isNibiAgentPackageSelected(options.selectedResourcePackageIds)) {
    return null;
  }

  const publishedComponentIds = options.resolvePublishedComponentIds
    ? await options.resolvePublishedComponentIds()
    : null;
  if (publishedComponentIds == null) {
    loggers.logWarn(
      `[nibi-agent-deploy] manifest 未提供组件清单，沿用旧组件 id ${NIBI_AGENT_REMOTE_COMPONENT_FALLBACK_ID}`,
    );
    return NIBI_AGENT_REMOTE_COMPONENT_FALLBACK_ID;
  }

  const resolvedComponentId = selectNibiAgentRemoteComponentId(publishedComponentIds);
  if (!resolvedComponentId) {
    throw new Error(
      `[nibi-agent-deploy] manifest 未发布 Nibi Agent 组件（需要 ${NIBI_AGENT_REMOTE_COMPONENT_IDS.join(
        " 或 ",
      )}）；拒绝跳过必需组件部署`,
    );
  }
  return resolvedComponentId;
}

async function shouldSkipNibiAgentDeploy(params: {
  backend: IRemoteBackend;
  remoteBinaryPath: string;
  remoteBundlePath: string;
  runtimeResourceDir: string;
  expectedArtifactSha256: string | null;
  componentId: string;
  platformArch: string;
  force: boolean;
  missingOfficialPluginAssetPaths: string[];
  installer: RemoteAssetInstaller;
  loggers: DeployLoggers;
}): Promise<boolean> {
  if (params.force) {
    return false;
  }

  if (!params.expectedArtifactSha256) {
    params.loggers.logWarn(
      `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=manifest SHA unavailable`,
    );
    return false;
  }

  const identityDecision = await checkRemoteAssetComponentIdentity(params.backend, {
    componentId: params.componentId,
    platformArch: params.platformArch,
    expectedIdentity: { sha256: params.expectedArtifactSha256 },
  });
  if (identityDecision.shouldDeploy) {
    params.loggers.logWarn(
      `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=${identityDecision.reason}`,
    );
    return false;
  }

  if (!(await params.backend.exists(params.remoteBinaryPath))) {
    params.loggers.logWarn(
      `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=remote wrapper missing path=${params.remoteBinaryPath}`,
    );
    return false;
  }

  if (isWslBackend(params.backend)) {
    try {
      const remoteWrapper = await params.backend.readFile(params.remoteBinaryPath);
      if (!isRemoteAgentBundleWrapperCurrent(remoteWrapper, params.runtimeResourceDir)) {
        params.loggers.logWarn(
          `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=wsl wrapper stale path=${params.remoteBinaryPath}`,
        );
        return false;
      }
    } catch {
      return false;
    }
  }

  // wrapper 在、但 nibi.cjs 缺失（被清理 / 旧原生二进制部署残留）时也要重新部署。
  if (!(await params.backend.exists(params.remoteBundlePath))) {
    params.loggers.logWarn(
      `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=remote bundle missing path=${params.remoteBundlePath}`,
    );
    return false;
  }

  if (params.missingOfficialPluginAssetPaths.length > 0) {
    params.loggers.logWarn(
      `[remote-assets] ${params.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${params.componentId} reason=official plugin assets missing paths=${params.missingOfficialPluginAssetPaths.join(",")}`,
    );
    return false;
  }

  params.loggers.log(
    `[nibi-agent-deploy] ${NIBI_AGENT_PROVIDER}: 制品 SHA ${params.expectedArtifactSha256} 已部署，跳过`,
  );
  return true;
}

async function findMissingRemoteOfficialPluginAssetPaths(
  backend: IRemoteBackend,
  remoteProviderDir: string,
): Promise<string[]> {
  const missingPaths: string[] = [];
  for (const remotePath of buildRemoteAgentOfficialPluginRequiredPaths(remoteProviderDir)) {
    if (!(await backend.exists(remotePath))) {
      missingPaths.push(remotePath);
    }
  }
  return missingPaths;
}

/**
 * 部署 Nibi Agent runtime 到远程机器。
 *
 * 生产态只用 manifest SHA 判断制品是否变化；语义版本不参与跳过决策。
 */
export async function deployNibiAgentRuntime(
  backend: IRemoteBackend,
  env: RemoteEnvironment,
  options: DeployNibiAgentRuntimeOptions,
  loggers: DeployLoggers,
): Promise<void> {
  const provider = NIBI_AGENT_PROVIDER;
  const runtime = NIBI_AGENT_RUNTIME;
  // lane 值与 CDN 组件 id 解耦：manifest 同时发布新/旧 id 时优先新 id，
  // 只有旧 manifest 才回退 glm；两个 id 都没有时 resolver 会 fail-closed。
  const componentId =
    options.componentId ?? (await resolveNibiAgentRemoteComponentId(options, loggers));
  if (!componentId) {
    loggers.log(`[nibi-agent-deploy] ${provider}: 未选择 Nibi Agent 资源包，跳过检查和部署`);
    return;
  }

  // binaryName 指 wrapper 可执行文件名（如 nibi-agent / nibi-agent.exe）——
  // 一个调用远端 node 执行 nibi.cjs 的壳脚本。
  const binaryName = runtime.resolveEntrySegments(env.platform).at(-1);
  if (!binaryName) {
    loggers.logWarn(`[nibi-agent-deploy] ${provider}: 无法解析 agent 入口名称，跳过部署`);
    return;
  }

  const remoteProviderDir = `${REMOTE_AGENT_RUNTIME_BASE}/${runtime.bundledResourceDir}`;
  const remoteVersionFile = `${remoteProviderDir}/.version`;
  const remoteBinaryPath = `${remoteProviderDir}/${binaryName}`;
  const remoteBundlePath = `${remoteProviderDir}/${REMOTE_AGENT_BUNDLE_NAME}`;
  const remoteOfficialPluginDir = buildRemoteAgentOfficialPluginDir(remoteProviderDir);
  const missingOfficialPluginAssetPaths = await findMissingRemoteOfficialPluginAssetPaths(
    backend,
    remoteProviderDir,
  );

  if (
    await deployDevelopmentNibiAgentRuntime(
      backend,
      {
        runtimeVersion: runtime.version,
        runtimeResourceDir: runtime.bundledResourceDir,
        remoteProviderDir,
        remoteVersionFile,
        remoteBinaryPath,
        force: Boolean(options.force),
      },
      loggers,
    )
  ) {
    return;
  }

  let expectedArtifactSha256: string | null = null;
  try {
    expectedArtifactSha256 =
      (await options.installer.resolveComponentSha256?.(componentId)) ?? null;
  } catch (error) {
    loggers.logWarn(
      `[nibi-agent-deploy] ${provider}: 读取 manifest SHA 失败，将重新部署: ${String(error)}`,
    );
  }

  if (
    await shouldSkipNibiAgentDeploy({
      backend,
      remoteBinaryPath,
      remoteBundlePath,
      runtimeResourceDir: runtime.bundledResourceDir,
      expectedArtifactSha256,
      componentId,
      platformArch: options.platformArch,
      force: Boolean(options.force),
      missingOfficialPluginAssetPaths,
      installer: options.installer,
      loggers,
    })
  ) {
    return;
  }

  loggers.log(`[nibi-agent-deploy] ${provider}: 开始部署 v${runtime.version}...`);
  // 缺少远端 plugin 只表示安装不完整，不等于 App 版本变化。
  // 同 App 版本修复 plugin 时应复用已校验的组件 cache；只有强制部署边界才重新下载制品。
  const forceRefreshRuntimeAsset = Boolean(options.force);
  const permissionRepairSucceeded = await repairLegacyRemoteOfficialPluginDirectoryPermissions({
    backend,
    loggers,
    remoteOfficialPluginDir,
  });
  const installBundle = () =>
    options.installer.installFile({
      componentId,
      // 源目录必须跟着本次解析出的 manifest id 走：新 id 用 nibi-agent/<arch>，
      // 旧 manifest 回退时仍是 glm/<arch>。
      sourceRelativePath: `${componentId}/${options.platformArch}/${REMOTE_AGENT_BUNDLE_NAME}`,
      remotePath: remoteBundlePath,
      executable: false,
      forceRefresh: forceRefreshRuntimeAsset,
    });
  const installOfficialPluginPackages = () =>
    options.installer.installDirectory({
      componentId,
      sourceRelativePath: buildRemoteAgentOfficialPluginSourceRelativePath({
        runtimeResourceDir: componentId,
        platformArch: options.platformArch,
      }),
      remoteDir: remoteOfficialPluginDir,
      requiredRelativePaths: [...REMOTE_AGENT_OFFICIAL_PLUGIN_REQUIRED_RELATIVE_PATHS],
      forceRefresh: forceRefreshRuntimeAsset,
    });

  if (permissionRepairSucceeded) {
    // 1) 正常路径保持原部署顺序，避免改变健康 SSH / Docker / WSL 的时序语义。
    await installBundle();
    // 2) 安装随 agent bundle 发布的官方插件源资源，供远端 agent bootstrap seed builtin plugin。
    await installOfficialPluginPackages();
  } else {
    // 1) chmod 失败时先验证 packages 可替换，避免 bundle 已更新但旧 packages 删除失败。
    await installOfficialPluginPackages();
    // 2) packages 替换成功后再安装编译产物 nibi.cjs（跨平台同一份，glm 组件里就是它）。
    await installBundle();
  }
  // 3) 写入 wrapper（即 resolver 期望的 nibi-agent），用远端已部署的 node 执行 nibi.cjs。
  await deployRemoteAgentWrapper({
    backend,
    content: buildRemoteAgentBundleWrapper(runtime.bundledResourceDir),
    remoteWrapperPath: remoteBinaryPath,
  });

  const versionStream = await backend.exec(
    buildWriteLiteralFileCommand(remoteVersionFile, runtime.version),
  );
  await waitForClose(versionStream);
  if (expectedArtifactSha256) {
    // GLM 的语义版本可能不变但制品内容已更新，必须把 manifest SHA
    // 写入远端 live marker，下一次连接才能按真实制品身份决定是否重部署。
    await writeRemoteAssetComponentMeta(backend, {
      id: componentId,
      version: runtime.version,
      sha256: expectedArtifactSha256,
      platformArch: options.platformArch,
    });
  }
  loggers.log(`[nibi-agent-deploy] ${provider}: 部署完成 v${runtime.version}`);
}
