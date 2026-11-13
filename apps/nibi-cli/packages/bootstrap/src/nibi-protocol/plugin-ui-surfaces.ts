// `plugins/listUiSurfaces`：工作区级只读投影，
// 返回已启用插件清单 `ui.surfaces[]` 的合法条目。与 plugin-reference-catalog.ts 同因分文件：plugins.ts 已近门禁。
import {
  nibiPluginsListUiSurfacesParamsSchema,
  type NibiPluginUiSurface,
  type NibiPluginsListUiSurfacesResult,
} from "@nibi/shared";
import type { PluginMetadata } from "@nibi/contracts";
import { resolveNibiPlugins } from "../plugins.js";
import { parseParams } from "./server-types.js";
import type { PluginManagementContext } from "./plugins.js";

export function listPluginUiSurfacesFromPlugins(
  plugins: readonly PluginMetadata[],
): NibiPluginUiSurface[] {
  const surfaces: NibiPluginUiSurface[] = [];
  for (const plugin of plugins) {
    // 禁用插件没有运行时 MCP，入口不可用；解析仍保留在 metadata 里供管理页展示。
    if (!plugin.enabled) continue;
    for (const surface of plugin.uiSurfaces ?? []) {
      surfaces.push({
        pluginId: plugin.id,
        pluginName: plugin.name,
        id: surface.id,
        title: surface.title,
        ...(surface.icon ? { icon: surface.icon } : {}),
        server: surface.server,
        resourceUri: surface.resourceUri,
        availability: surface.availability,
      });
    }
  }
  return surfaces;
}

export async function listPluginUiSurfaces(
  context: PluginManagementContext,
  rawParams: unknown,
): Promise<NibiPluginsListUiSurfacesResult> {
  const params = parseParams(nibiPluginsListUiSurfacesParamsSchema, rawParams);
  const outcome = resolveNibiPlugins({
    logger: context.logger,
    workingDirectory: params.workspace.workspacePath,
  });
  return { surfaces: listPluginUiSurfacesFromPlugins(outcome.plugins) };
}
