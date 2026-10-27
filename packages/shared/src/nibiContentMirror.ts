/**
 * NIBI content mirror configuration and URL mapping.
 *
 * This module is browser-safe: store icons and share pages run in the renderer,
 * which cannot import `shared/node` without pulling Node builtins into the
 * bundle. The open-source build has no mirror configured; deployments that
 * operate one can call `setNibiMirrorOrigin` during startup or patch
 * `NIBI_MIRROR_ORIGIN` in their build.
 *
 * Only NIBI's own content hosts are ever rewritten. User-added marketplaces and
 * third-party sources always return null.
 */

/** Empty in the open-source build. A deployment may replace this constant. */
export const NIBI_MIRROR_ORIGIN = "";

const NIBI_PRIMARY_CONTENT_HOSTS = new Set(["api.nibistudio.top", "dl.nibistudio.top"]);

let mirrorOrigin = NIBI_MIRROR_ORIGIN;

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Current mirror origin, or an empty string when no mirror is configured. */
export function getNibiMirrorOrigin(): string {
  return mirrorOrigin;
}

/**
 * Set the mirror origin at runtime. Invalid or empty input disables mirror
 * rewriting. The origin is normalized (`https://host:port`, no path).
 */
export function setNibiMirrorOrigin(origin: string): void {
  const parsed = parseUrl(origin.trim());
  mirrorOrigin = parsed ? parsed.origin : "";
}

/** Whether the URL belongs to one of NIBI's primary content hosts. */
export function isNibiPrimaryContentUrl(raw: string): boolean {
  const url = parseUrl(raw);
  return url !== null && NIBI_PRIMARY_CONTENT_HOSTS.has(url.hostname);
}

/** Whether the URL points at the configured mirror host. */
export function isNibiMirrorContentUrl(raw: string): boolean {
  const url = parseUrl(raw);
  const mirror = parseUrl(mirrorOrigin);
  return url !== null && mirror !== null && url.origin === mirror.origin;
}

/**
 * Map a primary content URL to the same path on the mirror. Returns null when
 * the input is not a NIBI primary host or no mirror is configured.
 */
export function nibiMirrorUrlForContent(raw: string): string | null {
  const url = parseUrl(raw);
  if (!url || !NIBI_PRIMARY_CONTENT_HOSTS.has(url.hostname)) return null;
  const mirror = parseUrl(mirrorOrigin);
  if (!mirror) return null;
  const mapped = new URL(url.toString());
  mapped.protocol = mirror.protocol;
  mapped.hostname = mirror.hostname;
  mapped.port = mirror.port;
  return mapped.toString();
}
