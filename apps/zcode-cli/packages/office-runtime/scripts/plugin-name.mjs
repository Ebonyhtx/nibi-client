import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 读取插件根目录插件清单（.nibi-plugin 优先，其次 .zcode-plugin）的 name。
 *
 * 原因：插件名决定 MCP 服务身份与 ui://<name>/ 资源地址。内置插件包目录名带 -plugin 后缀
 * （如 pdf-plugin），不能再从目录名推导，否则面板资源地址与 manifest 声明的 resourceUri 不一致。
 */
export async function readPluginName(pluginRoot) {
  // 双格式：内置件已迁到 .nibi-plugin，第三方/旧副本可能仍是 .zcode-plugin。
  const candidates = ["nibi-plugin", "zcode-plugin"].map((dir) => join(pluginRoot, `.${dir}`, "plugin.json"));
  const manifestPath = candidates.find((path) => existsSync(path));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (typeof manifest.name !== "string" || manifest.name.length === 0)
    throw new Error(`${manifestPath}: 缺少插件 name`);
  return manifest.name;
}
