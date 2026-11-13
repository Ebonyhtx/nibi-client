import {
  NIBI_AGENT_PROVIDER,
  NIBI_AGENT_PROVIDER_LABEL,
  type NibiProvider,
} from "@nibi/shared";

export const NIBI_AGENT_PROVIDERS: NibiProvider[] = [NIBI_AGENT_PROVIDER];

export const NIBI_AGENT_PROVIDER_LABELS: Record<NibiProvider, string> = {
  glm: NIBI_AGENT_PROVIDER_LABEL,
};

export function supportsNibiSessionFork(provider: NibiProvider): boolean {
  void provider;
  // 功能开关：fork 入口恢复对所有 Nibi provider 开放；实际可操作性仍由 task 状态、
  // assistant 目标和运行中保护 guard 控制，避免把 active/failed 分支暴露为可 fork。
  return true;
}

export function shouldHideNibiSessionForkAction(provider: NibiProvider): boolean {
  return !supportsNibiSessionFork(provider);
}
