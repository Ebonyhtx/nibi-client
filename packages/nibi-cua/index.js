/**
 * Package root for the open-source build.
 *
 * The public runtime is intentionally fail-closed: it never starts a Helper
 * and never pretends that a Computer Use action succeeded. Official NIBI
 * builds replace this package with the full implementation.
 */

const UNAVAILABLE_TEXT = "Computer Use is not available in this build.";

export function createComputerUseRuntime(_options = {}) {
  return {
    async execute() {
      return { content: [{ type: "text", text: UNAVAILABLE_TEXT }], isError: true };
    },
    async closeSession() {},
    async dispose() {},
  };
}
