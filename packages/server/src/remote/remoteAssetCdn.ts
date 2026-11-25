import { posix } from "node:path";

export function buildReleaseBaseCandidates(remoteCdnBaseUrls: string[], version: string): string[] {
  const candidates = remoteCdnBaseUrls.flatMap((remoteCdnBaseUrl) => {
    const normalizedBase = remoteCdnBaseUrl.replace(/\/+$/, "");
    // 当调用方已经传入带版本的 CDN 基址时，继续盲目拼 `${base}/${version}`
    // 会先走一次必然失败的双版本路径（例如 .../0.2.10/0.2.10），产生无意义 404 噪音。
    // 这里识别“已固定到当前版本”的场景，直接使用原基址即可。
    if (normalizedBase.endsWith(`/${version}`)) {
      return [normalizedBase];
    }
    return [`${normalizedBase}/${version}`, normalizedBase];
  });
  return Array.from(new Set(candidates));
}

export function buildReleaseAssetUrlCandidates(
  releaseBaseCandidates: string[],
  fileCandidates: string[],
): string[] {
  const urls: string[] = [];
  for (const fileCandidate of fileCandidates) {
    const normalizedFileCandidate = normalizeRemoteAssetRelativePath(
      fileCandidate,
      "release asset path",
    );
    for (const releaseBaseCandidate of releaseBaseCandidates) {
      urls.push(joinCdnUrl(releaseBaseCandidate, normalizedFileCandidate));
    }
  }
  return Array.from(new Set(urls));
}

function normalizeRemoteAssetRelativePath(rawPath: string, label: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new Error(`[remote-assets] ${label} is empty`);
  }
  if (trimmed.includes("\\")) {
    throw new Error(`[remote-assets] ${label} must not contain backslash: ${rawPath}`);
  }
  if (trimmed.startsWith("/") || /^[A-Za-z]:/u.test(trimmed)) {
    throw new Error(`[remote-assets] ${label} must be relative path: ${rawPath}`);
  }

  const rawSegments = trimmed.split("/");
  if (rawSegments.some((segment) => segment.length === 0)) {
    throw new Error(`[remote-assets] ${label} contains empty path segment: ${rawPath}`);
  }
  if (rawSegments.includes("..")) {
    throw new Error(`[remote-assets] ${label} must not contain '..': ${rawPath}`);
  }
  if (rawSegments.includes(".")) {
    throw new Error(`[remote-assets] ${label} must not contain '.': ${rawPath}`);
  }

  const normalized = posix.normalize(trimmed);
  const normalizedSegments = normalized.split("/");
  if (
    normalizedSegments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`[remote-assets] ${label} is invalid after normalize: ${rawPath}`);
  }

  return normalizedSegments.join("/");
}

function joinCdnUrl(baseUrl: string, relativePath: string): string {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  // 版本里可能带 '+'（如 v1.3.0+abcd），直接拼 URL 会在部分 CDN 侧命中失败（404）。
  // 这里按路径段做 URL 编码，保证对象 key 与下载 URL 一致（+ -> %2B）。
  const encodedRelativePath = encodeRelativePathForUrl(relativePath);
  return `${normalizedBase}/${encodedRelativePath}`;
}

function encodeRelativePathForUrl(relativePath: string): string {
  return relativePath
    .split("/")
    .map((segment) => encodePathSegment(segment))
    .join("/");
}

function encodePathSegment(segment: string): string {
  // 兼容已编码输入：先尝试解码再编码，避免把 %2B 再编码成 %252B。
  // 若输入包含非法 '%' 序列则回退到直接编码，确保不会抛异常。
  try {
    return encodeURIComponent(decodeURIComponent(segment));
  } catch {
    return encodeURIComponent(segment);
  }
}
