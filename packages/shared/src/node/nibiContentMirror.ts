/**
 * Node-side NIBI content mirror helpers.
 *
 * The open-source build ships without a mirror: `NIBI_MIRROR_ORIGIN` is empty
 * and `NIBI_MIRROR_CA_PEM` has no certificate. Deployments that operate a
 * private mirror inject both values at build time (see the private release
 * overlay). Primary content hosts continue to use the system trust store.
 */

import {
  getNibiMirrorOrigin,
  isNibiMirrorContentUrl,
  nibiMirrorUrlForContent,
  setNibiMirrorOrigin,
} from "../nibiContentMirror.js";

export {
  NIBI_MIRROR_ORIGIN,
  getNibiMirrorOrigin,
  isNibiMirrorContentUrl,
  isNibiPrimaryContentUrl,
  nibiMirrorUrlForContent,
  setNibiMirrorOrigin,
} from "../nibiContentMirror.js";

/**
 * Optional private mirror CA (PEM). Empty in the open-source build; a release
 * overlay may replace this value.
 */
export const NIBI_MIRROR_CA_PEM = "";

/** Whether the URL points at the configured mirror host. */
export const isNibiMirrorUrl = isNibiMirrorContentUrl;

/** Map a primary content URL to the mirror; shared with the renderer. */
export const nibiMirrorUrlFor = nibiMirrorUrlForContent;

/** Candidate URLs: primary first, mirror second when one is configured. */
export function nibiContentUrlCandidates(raw: string): string[] {
  const mirror = nibiMirrorUrlFor(raw);
  return mirror && mirror !== raw ? [raw, mirror] : [raw];
}

/** Apply a deployment-provided mirror origin and CA at startup. */
export function configureNibiContentMirror(origin: string): void {
  setNibiMirrorOrigin(origin);
}

/** Current mirror origin (empty when disabled). */
export function currentNibiMirrorOrigin(): string {
  return getNibiMirrorOrigin();
}
