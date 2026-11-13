import type { NibiProvider } from "@nibi/shared";

export const NIBI_MODE_OPTION_LABEL_IDS: Record<NibiProvider, Record<string, string>> = {
  "nibi-agent": {
    default: "mode.label.nibiAgent.default",
    build: "mode.label.nibiAgent.build",
    edit: "mode.label.nibiAgent.edit",
    plan: "mode.label.nibiAgent.plan",
    yolo: "mode.label.nibiAgent.yolo",
    guarded: "mode.label.nibiAgent.guarded",
  },
};

export const NIBI_MODE_OPTION_DESCRIPTION_IDS: Record<NibiProvider, Record<string, string>> = {
  "nibi-agent": {
    default: "mode.description.nibiAgent.default",
    build: "mode.description.nibiAgent.build",
    edit: "mode.description.nibiAgent.edit",
    plan: "mode.description.nibiAgent.plan",
    yolo: "mode.description.nibiAgent.yolo",
    guarded: "mode.description.nibiAgent.guarded",
  },
};
