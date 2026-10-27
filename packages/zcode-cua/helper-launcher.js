/**
 * Public Helper launcher contract.
 *
 * The launcher wiring is part of the public integration surface, but the
 * Helper binary itself is not included in this repository. Every entry point
 * therefore reports unavailable instead of spawning a process.
 */

import { CuaHelperError } from "./broker.js";

export const HELPER_RECIPE_ENV = "NIBI_CUA_WIN_HELPER_RECIPE";
export const HELPER_ADDON_ENV = "NIBI_CUA_HELPER_ADDON";
export const HELPER_CONTROL_PROTOCOL = "zcode-cua-windows-dev/v1";

const UNAVAILABLE_TEXT = "Computer Use is not available in this build.";

export function parseHelperRecipe(_raw) {
  return null;
}

export async function spawnCuaHelper(_options) {
  throw new CuaHelperError(UNAVAILABLE_TEXT, { code: "unavailable" });
}

export function createHelperLauncher(_options = {}) {
  return {
    available: false,
    reason: UNAVAILABLE_TEXT,
    async ensure() {
      throw new CuaHelperError(UNAVAILABLE_TEXT, { code: "unavailable" });
    },
  };
}
