/**
 * Node-only shared utilities.
 *
 * This subpath must not be imported by renderer/browser bundles.
 */
export { acquireFileLock } from "./node/atomicFileLock.js";
export {
  chooseEgressProxyUrl,
  isImplicitDirectUrl,
  matchesNoProxyRule,
  mergeImplicitNoProxy,
  normalizeEgressProxyUrl,
  resolveEgressProxyForUrl,
  resolveHttpProxyMode,
  withEffectiveEgressProxy,
  type EgressProxySettings,
  type HttpProxyMode,
} from "./node/egressProxy.js";
export {
  clearSystemProxyCache,
  detectSystemProxy,
  parseMacProxyOutput,
  parseWindowsProxyOutput,
  resolveSystemProxyUrl,
  type SystemProxyDetection,
} from "./node/systemProxy.js";
export { createNodeNetworkCapture, withoutNetworkCapture } from "./node/networkCapture.js";
export {
  GEN_UI_OUTPUT_ROOT_ENV,
  GEN_UI_OUTPUT_DIRECTORY,
  getGenUiOutputDirectory,
} from "./node/genUiPaths.js";
export { scanOfficialPluginCacheRoots } from "./node/officialPluginCache.js";
export {
  NIBI_CONTENT_SIGNING_PUBLIC_KEY_SPKI_BASE64,
  isNibiSignedContentUrl,
  verifyContentSignatureWithKey,
  verifyNibiContentSignature,
} from "./node/nibiContentSignature.js";
export {
  NIBI_MIRROR_CA_PEM,
  NIBI_MIRROR_ORIGIN,
  isNibiMirrorUrl,
  nibiContentUrlCandidates,
  nibiMirrorUrlFor,
} from "./node/nibiContentMirror.js";
export {
  migrateUserSubagentMarkdown,
  migrateSubagentStateFile,
} from "./node/subagentMarkdownMigration.js";
export {
  atomicWritePrivateTextFile,
  backupCorruptFile,
  withFileLock,
  type SharedFileLockOptions,
} from "./node/privateFilePersistence.js";
export {
  createNodeSelfResourceSampler,
  NODE_SELF_RESOURCE_SAMPLE_INTERVAL_MS,
  type NodeSelfResourceSampler,
  type NodeSelfResourceSamplerOptions,
} from "./node/nodeSelfResourceTelemetry.js";
