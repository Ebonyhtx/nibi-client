import {
  buildRuntimeZCodeEndpointUrls,
  NIBI_ENV,
  type RuntimeZCodeEndpointEnv,
} from "@nibi/shared";

interface RendererImportMetaEnv {
  VITE_NIBI_BASE_URL?: string;
  VITE_NIBI_ENDPOINT_ORIGIN?: string;
}

function readRendererImportMetaEnv(): RendererImportMetaEnv {
  return ((import.meta as ImportMeta & { env?: RendererImportMetaEnv }).env ??
    {}) as RendererImportMetaEnv;
}

export function createRendererZCodeEndpointEnv(
  env: RendererImportMetaEnv = readRendererImportMetaEnv(),
): RuntimeZCodeEndpointEnv {
  return {
    NIBI_ENV,
    // UI 侧的 zcode-plan 占位 provider 以前只看 NIBI_ENV，
    // 没有消费 Vite 注入的 base url，导致自定义测试域名时 renderer 和 host/service 可能不一致。
    NIBI_BASE_URL: env.VITE_NIBI_BASE_URL,
    NIBI_ENDPOINT_ORIGIN: env.VITE_NIBI_ENDPOINT_ORIGIN,
  };
}

export const RENDERER_NIBI_ENDPOINT_URLS = buildRuntimeZCodeEndpointUrls(
  createRendererZCodeEndpointEnv(),
);
