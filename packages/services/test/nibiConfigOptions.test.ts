import { describe, expect, it } from "vitest";
import type { NibiSessionSettingsState } from "@nibi/shared";
import {
  getNibiAgentAvailableModes,
  normalizeAvailableNibiMode,
  settingsToConfigOptions,
} from "../src/nibi-agent/nibiConfigOptions.js";

function settingsWithMode(
  mode: NibiSessionSettingsState["mode"]["current"],
): NibiSessionSettingsState {
  return {
    model: {
      current: { providerId: "glm", modelId: "glm-5" },
      available: [],
    },
    thoughtLevel: {
      enabled: false,
      available: [],
    },
    mode: { current: mode },
  };
}

describe("nibiConfigOptions", () => {
  it("keeps persisted edit while the shared menu replaces it with guarded", () => {
    const options = settingsToConfigOptions(settingsWithMode("edit"));
    const modeOption = options.find((option) => option.category === "mode");

    expect(modeOption?.currentValue).toBe("edit");
    expect(modeOption?.options?.map((option) => option.value)).toEqual([
      "build",
      "guarded",
      "plan",
      "yolo",
    ]);
    expect(getNibiAgentAvailableModes().map((mode) => mode.id)).toEqual([
      "build",
      "guarded",
      "plan",
      "yolo",
    ]);
    expect(normalizeAvailableNibiMode("edit")).toBe("edit");
  });
});
