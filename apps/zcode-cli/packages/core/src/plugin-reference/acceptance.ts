// 插件验收合同 → 宿主门禁可用的形态。
//
// 与 plugin-reference/catalog.ts 同址同因：都在 App（Session runtime）创建时由 bootstrap
// 从 resolveStartupPlugins 的结果构建一次，之后不随配置热更新。
//
// 这里做两件事：
//   1. 只保留 enabled 且合同校验通过的插件；
//   2. 按合同的 activation 判据决定它对**本工作区**是否生效。
//
// 第 2 点是必需的：插件可能被装在跟它无关的目录里，没有激活判据的话，凡是启用该插件的
// 会话，每个目标（包括一句「你好」）都会被它的阶段门禁拦一遍。
import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import type {
  PluginAcceptanceCheck,
  PluginAcceptanceContract,
  PluginMetadata,
} from "@nibi/contracts";

export interface ActivePluginAcceptance {
  contract: PluginAcceptanceContract;
  /** 插件数据目录：{{pluginData}} 的取值。 */
  pluginDataPath: string;
  pluginId: string;
  pluginName: string;
  /** 插件根目录：{{pluginRoot}} 的取值。 */
  pluginRootPath: string;
}

export interface ResolvedPluginAcceptance {
  /** 生效中的合同（已通过 activation 判据）。 */
  active: ActivePluginAcceptance[];
  /** 声明了合同但因 activation 不满足而未生效的插件名，供日志与插件详情解释。 */
  dormant: string[];
}

/**
 * 解析某个工作区里生效的验收合同。
 *
 * `workspacePath` 为空（例如子代理运行时没有工作目录）时视为没有工作区：
 * 只接受不带 activation 的合同。
 */
export function resolveActivePluginAcceptance(
  plugins: readonly PluginMetadata[],
  workspacePath: string | undefined | null,
): ResolvedPluginAcceptance {
  const active: ActivePluginAcceptance[] = [];
  const dormant: string[] = [];
  for (const plugin of plugins) {
    const contract = plugin.acceptance;
    if (!plugin.enabled || !contract) continue;
    if (!isAcceptanceActiveForWorkspace(contract, workspacePath)) {
      dormant.push(plugin.name);
      continue;
    }
    active.push({
      contract,
      pluginDataPath: plugin.dataPath,
      pluginId: plugin.id,
      pluginName: plugin.name,
      pluginRootPath: plugin.rootPath,
    });
  }
  return { active, dormant };
}

export function isAcceptanceActiveForWorkspace(
  contract: PluginAcceptanceContract,
  workspacePath: string | undefined | null,
): boolean {
  const relative = contract.activation?.workspacePathExists;
  if (!relative) return true;
  if (!workspacePath) return false;
  // 路径在解析期已被校验为工作区内的相对路径；这里再做一次逃逸检查，
  // 因为合同可能来自旧版本插件或被手工编辑过。
  const root = resolve(workspacePath);
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(root.endsWith(sep) ? root : root + sep)) return false;
  return existsSync(target);
}

/** 未被任何 stage 引用的必需检查归到这一组。 */
export const PREREQUISITE_STAGE_ID = "prerequisites";

/** 按 stage 顺序摊平检查，供门禁与 prompt 使用。
 *
 * ⛔ 必须包含"没有被任何 stage 引用的必需检查"。实测踩过：数模插件的两条环境检查
 * （environment-core / environment-paper）声明为 required + failClosed，但只写在
 * `checks` 里、没挂进任何 stage 的 gate —— 只按 stage 走的实现会**静默把它们丢掉**，
 * 于是"缺环境也能判定完成"。声明的必需项就该被强制，作者漏挂 stage 是他的账，
 * 不该由宿主替他免掉（解析期会给一条 warning 提示）。
 */
export function flattenAcceptanceChecks(
  acceptance: ActivePluginAcceptance,
): (PluginAcceptanceCheck & { stageId: string; stageTitle?: string })[] {
  const { contract } = acceptance;
  const flattened: (PluginAcceptanceCheck & { stageId: string; stageTitle?: string })[] = [];
  const referenced = new Set<string>();
  for (const stage of contract.stages) {
    for (const checkId of stage.gate.checks) {
      referenced.add(checkId);
      const check = contract.checks.find((item) => item.id === checkId);
      if (!check) continue;
      flattened.push({
        ...check,
        stageId: stage.id,
        ...(stage.title ? { stageTitle: stage.title } : {}),
      });
    }
  }
  for (const check of contract.checks) {
    if (referenced.has(check.id) || !check.required) continue;
    flattened.push({ ...check, stageId: PREREQUISITE_STAGE_ID });
  }
  return flattened;
}
