import { NIBI_AGENT_PROVIDER, type NibiProvider } from "@nibi/shared";
import { NibiAgentIcon } from "@/components/ui/NibiAgentIcon.js";

export function renderProviderCliIcon(
  _provider: NibiProvider = NIBI_AGENT_PROVIDER,
  className?: string,
) {
  return <NibiAgentIcon className={className} />;
}
