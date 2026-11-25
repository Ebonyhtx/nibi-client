// E2E fixture: poll the plugin's own settings until the spec arms it, then ask the
// host to open the declared "panel" surface exactly once.
//
// Activation happens lazily on the first plugin listing. Opening immediately would
// race the renderer, which drops openView while no task is active.

let stopped = false;
let timer = null;
let inFlight = false;

async function poll(context) {
  if (stopped || inFlight) return;
  inFlight = true;
  let settings = null;
  try {
    settings = await context.nibi.settings.get();
  } catch {
    // The host may not have granted the capability yet; keep polling.
    settings = null;
  }
  inFlight = false;
  if (stopped) return;
  if (settings && settings.armed === true) {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    try {
      await context.nibi.ui.openView("panel");
    } catch {
      // The spec asserts the side tab; throwing here would tear down the
      // extension host and hide the real failure cause.
    }
    return;
  }
  timer = setTimeout(() => {
    void poll(context);
  }, 250);
}

export async function activate(context) {
  stopped = false;
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => {
    void poll(context);
  }, 0);
}

export async function deactivate() {
  stopped = true;
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}
