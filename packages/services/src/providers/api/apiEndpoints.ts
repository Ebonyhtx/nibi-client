import { buildRuntimeZCodeApiUrl, resolveZaiBusinessBaseUrl } from "@nibi/shared";

export const NIBI_CLIENT_SCENES_URL = buildRuntimeZCodeApiUrl(
  process.env,
  "/api/v1/client/scenes",
);

export const ZAI_API_HOST = resolveZaiBusinessBaseUrl(process.env);
