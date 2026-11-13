import {
  nibiProtocolMethods,
  nibiPluginsReferenceCatalogResultSchema,
  type NibiPluginsReferenceCatalogParams,
} from "@nibi/shared";
import type { NibiProtocolClient } from "#src/nibi-agent/nibiProtocolClient.js";

/** 旧协议严格校验响应；新展示字段走独立入口，只有 -32601 能证明旧 Agent 不支持。 */
export async function requestPluginReferenceCatalog(
  client: Pick<NibiProtocolClient, "request">,
  params: NibiPluginsReferenceCatalogParams,
) {
  try {
    return await client.request(
      nibiProtocolMethods.pluginsReferenceCatalogWithCategory,
      params,
      nibiPluginsReferenceCatalogResultSchema,
    );
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && error.code === -32601))
      throw error;
    return client.request(
      nibiProtocolMethods.pluginsReferenceCatalog,
      params,
      nibiPluginsReferenceCatalogResultSchema,
    );
  }
}
