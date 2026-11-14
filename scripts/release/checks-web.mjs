#!/usr/bin/env node
// Web SPA 与插件市场的发布校验。HTTP 工具在 http.mjs。

import { errorMessage, isRecord, probeUrl, readJson, requestWithRetry } from "./http.mjs";

function webResult({ valid, current, detail, version, commit, evidence }) {
  return {
    kind: "web-release",
    valid,
    current,
    present: valid && current ? 1 : 0,
    total: 1,
    partial: false,
    detail,
    evidence: {
      ...evidence,
      ...(typeof version === "string" ? { version } : {}),
      ...(typeof commit === "string" ? { commit } : {}),
    },
  };
}

function readHtmlMeta(html, name) {
  const tags = html.match(/<meta\b[^>]*>/giu) ?? [];
  for (const tag of tags) {
    const nameMatch = tag.match(/\bname\s*=\s*["']([^"']+)["']/iu);
    if (nameMatch?.[1]?.toLowerCase() !== name.toLowerCase()) continue;
    const contentMatch = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/iu);
    if (contentMatch) return contentMatch[1];
  }
  return null;
}

async function checkWebReleaseJson({
  releaseUrl,
  surface,
  version,
  fetchImpl,
  retries,
  timeoutMs,
}) {
  let response;
  try {
    response = await requestWithRetry(releaseUrl, {
      fetchImpl,
      retries,
      timeoutMs,
      headers: { accept: "application/json" },
    });
  } catch (error) {
    return webResult({
      valid: false,
      current: false,
      detail: errorMessage(error),
      evidence: { source: "release.json", releaseUrl, surface },
    });
  }
  if (response.status === 404) {
    return webResult({
      valid: true,
      current: false,
      detail: "页面与 release.json 均 404（未部署）",
      evidence: { source: "release.json", releaseUrl, surface },
    });
  }
  if (!response.ok) {
    return webResult({
      valid: false,
      current: false,
      detail: `release.json HTTP ${response.status}`,
      evidence: { source: "release.json", releaseUrl, surface },
    });
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    return webResult({
      valid: false,
      current: false,
      detail: "release.json 返回 HTML（SPA fallback，部署未接入标记）",
      evidence: { source: "release.json", releaseUrl, surface },
    });
  }
  let manifest;
  try {
    manifest = await readJson(response);
  } catch (error) {
    return webResult({
      valid: false,
      current: false,
      detail: errorMessage(error),
      evidence: { source: "release.json", releaseUrl, surface },
    });
  }
  if (
    !isRecord(manifest) ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.version !== "string" ||
    typeof manifest.surface !== "string"
  ) {
    return webResult({
      valid: false,
      current: false,
      detail: "release.json 结构不合法",
      evidence: { source: "release.json", releaseUrl, surface },
    });
  }
  const surfaceMatches = manifest.surface === surface;
  return webResult({
    valid: surfaceMatches,
    current: surfaceMatches && manifest.version === version,
    detail: surfaceMatches
      ? `release.json ${manifest.version}`
      : `release.json surface=${manifest.surface}，期望 ${surface}`,
    version: manifest.version,
    commit: manifest.commit,
    evidence: { source: "release.json", releaseUrl, surface },
  });
}

/**
 * Web SPA 优先读页面 `<meta name="nibi-release-*">`：两个 SPA 的 index.html 都是
 * no-cache，部署后立刻能读到新版本；release.json 可能被静态缓存一天，只作为兜底。
 * 页面存在但没有 meta 时如实报“未接入标记”，不把缓存的 release.json 当成页面版本。
 */
export async function checkWebRelease(artifact, { version, fetchImpl, retries, timeoutMs } = {}) {
  const { pageUrl, releaseUrl, surface } = artifact.check;
  let response;
  let pageError = null;
  try {
    response = await requestWithRetry(pageUrl, {
      fetchImpl,
      retries,
      timeoutMs,
      headers: { accept: "text/html,application/xhtml+xml" },
    });
  } catch (error) {
    pageError = error;
  }

  if (!response) {
    const fallback = await checkWebReleaseJson({
      releaseUrl,
      surface,
      version,
      fetchImpl,
      retries,
      timeoutMs,
    });
    if (fallback.valid) return fallback;
    return webResult({
      valid: false,
      current: false,
      detail: errorMessage(pageError),
      evidence: { source: "page", pageUrl, releaseUrl, surface },
    });
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (response.ok && contentType.includes("text/html")) {
    const html = await response.text();
    const pageVersion = readHtmlMeta(html, "nibi-release-version");
    const pageSurface = readHtmlMeta(html, "nibi-release-surface");
    const pageCommit = readHtmlMeta(html, "nibi-release-commit");
    if (!pageVersion || !pageSurface) {
      return webResult({
        valid: true,
        current: false,
        detail: "页面缺少 nibi-release meta（部署未接入标记）",
        evidence: { source: "page", pageUrl, releaseUrl, surface },
      });
    }
    const surfaceMatches = pageSurface === surface;
    return webResult({
      valid: surfaceMatches,
      current: surfaceMatches && pageVersion === version,
      detail: surfaceMatches
        ? `页面 ${pageVersion}`
        : `页面 surface=${pageSurface}，期望 ${surface}`,
      version: pageVersion,
      commit: pageCommit,
      evidence: { source: "page", pageUrl, releaseUrl, surface },
    });
  }

  if (response.status === 404) {
    return checkWebReleaseJson({
      releaseUrl,
      surface,
      version,
      fetchImpl,
      retries,
      timeoutMs,
    });
  }
  if (!response.ok) {
    return webResult({
      valid: false,
      current: false,
      detail: `页面 HTTP ${response.status}`,
      evidence: { source: "page", pageUrl, releaseUrl, surface },
    });
  }

  // 页面 200 但不是 HTML（例如被网关重定向到 JSON）：仍允许用 release.json 兜底。
  return checkWebReleaseJson({
    releaseUrl,
    surface,
    version,
    fetchImpl,
    retries,
    timeoutMs,
  });
}

function hasValidZipSource(source) {
  return (
    isRecord(source) &&
    source.type === "zip" &&
    typeof source.url === "string" &&
    source.url.startsWith("https://") &&
    /^[a-f0-9]{64}$/u.test(String(source.sha256 ?? ""))
  );
}

/**
 * 插件市场：目录与 zip 摘要必须同时存在。付费包的下载端点本来就会 401/403，
 * 这不算坏；404/410 才说明目录指向了不存在的包。
 */
export async function checkPluginMarket(
  artifact,
  { fetchImpl, retries, timeoutMs, baseline } = {},
) {
  const { catalogUrl, plugin } = artifact.check;
  let response;
  try {
    response = await requestWithRetry(catalogUrl, {
      fetchImpl,
      retries,
      timeoutMs,
      headers: { accept: "application/json" },
    });
  } catch (error) {
    return {
      kind: "plugin-market",
      valid: false,
      current: false,
      present: 0,
      total: 1,
      partial: false,
      detail: errorMessage(error),
      evidence: { catalogUrl },
    };
  }
  if (!response.ok) {
    return {
      kind: "plugin-market",
      valid: false,
      current: false,
      present: 0,
      total: 1,
      partial: false,
      detail: `marketplace.json HTTP ${response.status}`,
      evidence: { catalogUrl },
    };
  }
  let catalog;
  try {
    catalog = await readJson(response);
  } catch (error) {
    return {
      kind: "plugin-market",
      valid: false,
      current: false,
      present: 0,
      total: 1,
      partial: false,
      detail: errorMessage(error),
      evidence: { catalogUrl },
    };
  }
  if (
    !isRecord(catalog) ||
    !Number.isSafeInteger(catalog.revision) ||
    catalog.revision < 1 ||
    !Array.isArray(catalog.plugins)
  ) {
    return {
      kind: "plugin-market",
      valid: false,
      current: false,
      present: 0,
      total: 1,
      partial: false,
      detail: "marketplace.json 结构不合法",
      evidence: { catalogUrl },
    };
  }
  const entry = catalog.plugins.find((item) => isRecord(item) && item.name === plugin);
  if (!entry || typeof entry.version !== "string" || !hasValidZipSource(entry.source)) {
    return {
      kind: "plugin-market",
      valid: false,
      current: false,
      present: 0,
      total: 1,
      partial: false,
      detail: `目录缺少 ${plugin} 或 zip/sha256 不合法`,
      evidence: { catalogUrl, revision: catalog.revision },
    };
  }
  const zip = await probeUrl(entry.source.url, { fetchImpl, retries, timeoutMs });
  const gated = zip.status === 401 || zip.status === 403;
  const valid = zip.ok || gated;
  const baselineRevision = baseline?.revision ?? null;
  const baselineVersion = baseline?.version ?? null;
  const current =
    baselineRevision === null ||
    (catalog.revision === baselineRevision && entry.version === baselineVersion);
  const detailParts = [
    `revision ${catalog.revision}`,
    `${plugin} ${entry.version}`,
    zip.ok ? "zip 200" : gated ? `zip ${zip.status}（付费门禁）` : `zip ${zip.status || "不可达"}`,
  ];
  if (baselineRevision !== null && catalog.revision > baselineRevision) {
    detailParts.push(`台账 ${baselineRevision}，待登记`);
  } else if (baselineRevision !== null && catalog.revision < baselineRevision) {
    detailParts.push(`低于台账 ${baselineRevision}`);
  } else if (baselineVersion !== null && entry.version !== baselineVersion) {
    detailParts.push(`版本与台账 ${baselineVersion} 不同`);
  }
  return {
    kind: "plugin-market",
    valid,
    current: valid && current,
    present: valid && current ? 1 : 0,
    total: 1,
    partial: baselineRevision !== null && valid && !current,
    detail: detailParts.join("；"),
    revision: catalog.revision,
    pluginVersion: entry.version,
    baseline,
    evidence: {
      catalogUrl,
      revision: catalog.revision,
      generatedAt: catalog.generatedAt,
      plugin: { name: plugin, version: entry.version, source: entry.source },
      zip: { status: zip.status, size: zip.size },
    },
  };
}
