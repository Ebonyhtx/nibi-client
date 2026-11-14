#!/usr/bin/env node
// 发布产物的远程/线上校验。所有网络请求都允许注入 fetch，测试不需要联网。
//
// 每个 check 返回同一形状，供 status/verify 统一判断：
//   valid    —— 远端接口本身可用、返回结构合法（404/未发布也算 valid）
//   current  —— 当前产品版本在这个产物上已经完整可见
//   present  —— 当前版本已出现的子项数量（npm 包、Source Server target、桌面平台）
//   total    —— 子项总数
//   partial  —— 当前版本只出现了一部分（没有 present 的产物用这个标记）
//   detail   —— 一行人类可读说明
//   evidence —— 机器可读的远端事实（查台账/排障用）

import {
  downloadAndHash,
  errorMessage,
  isRecord,
  probeUrl,
  readJson,
  requestWithRetry,
} from "./http.mjs";
import { checkPluginMarket, checkWebRelease } from "./checks-web.mjs";

export function npmRegistryUrl(packageName) {
  return `https://registry.npmjs.org/${packageName.replace("/", "%2F")}`;
}

/**
 * npm 平台包 + META。META 必须精确锁定同版本四个平台包，否则即使用户装到
 * 入口包，也可能在某个平台装不出可用内核。
 */
export async function checkNpm(artifact, { version, fetchImpl, retries, timeoutMs } = {}) {
  const platformPackages = artifact.check.packages ?? [];
  const meta = artifact.check.meta;
  const packages = [...platformPackages, ...(meta ? [meta] : [])];
  const expectedMetaDependencies = Object.fromEntries(
    platformPackages.map((name) => [name, version]),
  );
  const results = await Promise.all(
    packages.map(async (name) => {
      try {
        const response = await requestWithRetry(npmRegistryUrl(name), {
          fetchImpl,
          retries,
          timeoutMs,
        });
        if (response.status === 404) return { name, state: "absent" };
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await readJson(response);
        const published = data?.versions?.[version];
        const latest = data?.["dist-tags"]?.latest;
        if (!published) return { name, state: "absent", latest };
        const integrity = published?.dist?.integrity;
        const tarball = published?.dist?.tarball;
        if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
          return { name, state: "invalid", latest, detail: "缺少 sha512 integrity" };
        }
        if (typeof tarball !== "string" || !tarball.startsWith("https://")) {
          return { name, state: "invalid", latest, detail: "缺少 HTTPS tarball" };
        }
        if (name === meta) {
          const actual = published?.optionalDependencies ?? {};
          const expectedKeys = Object.keys(expectedMetaDependencies).sort();
          const actualKeys = Object.keys(actual).sort();
          const exact =
            expectedKeys.length === actualKeys.length &&
            expectedKeys.every(
              (key, index) =>
                actualKeys[index] === key && actual[key] === expectedMetaDependencies[key],
            );
          if (!exact) {
            return {
              name,
              state: "invalid",
              latest,
              detail: "META optionalDependencies 没有精确锁定同版本平台包",
            };
          }
        }
        return { name, state: "present", latest };
      } catch (error) {
        return { name, state: "error", detail: errorMessage(error) };
      }
    }),
  );

  const present = results.filter((item) => item.state === "present").length;
  const invalid = results.filter((item) => item.state === "invalid");
  const errors = results.filter((item) => item.state === "error");
  const latest = results.find((item) => item.latest)?.latest;
  const valid = invalid.length === 0 && errors.length === 0;
  const detailParts = [`${present}/${packages.length} 已发布`];
  if (latest && present < packages.length) detailParts.push(`latest ${latest}`);
  if (invalid.length > 0)
    detailParts.push(`结构异常：${invalid.map((item) => item.name).join(", ")}`);
  if (errors.length > 0) detailParts.push(`查询失败：${errors.length} 个包`);
  return {
    kind: "npm",
    valid,
    current: present === packages.length && packages.length > 0,
    present,
    total: packages.length,
    partial: present > 0 || invalid.length > 0,
    detail: detailParts.join("；"),
    evidence: { packages: results },
  };
}

/**
 * Source Server：descriptor 是唯一发布合同，四个 archive 按 target 逐个核对
 * 存在、大小和（--deep 时）sha256。
 */
export async function checkSourceServer(
  artifact,
  { version, fetchImpl, retries, timeoutMs, deep = false } = {},
) {
  const { descriptorUrl, targets = [] } = artifact.check;
  const url = descriptorUrl.replaceAll("{version}", version);
  let response;
  try {
    response = await requestWithRetry(url, { fetchImpl, retries, timeoutMs });
  } catch (error) {
    return {
      kind: "source-server",
      valid: false,
      current: false,
      present: 0,
      total: targets.length,
      partial: false,
      detail: errorMessage(error),
      evidence: { descriptorUrl: url },
    };
  }
  if (response.status === 404) {
    return {
      kind: "source-server",
      valid: true,
      current: false,
      present: 0,
      total: targets.length,
      partial: false,
      detail: "descriptor 404（未发布）",
      evidence: { descriptorUrl: url },
    };
  }
  if (!response.ok) {
    return {
      kind: "source-server",
      valid: false,
      current: false,
      present: 0,
      total: targets.length,
      partial: false,
      detail: `descriptor HTTP ${response.status}`,
      evidence: { descriptorUrl: url },
    };
  }

  let descriptor;
  try {
    descriptor = await readJson(response);
  } catch (error) {
    return {
      kind: "source-server",
      valid: false,
      current: false,
      present: 0,
      total: targets.length,
      partial: false,
      detail: errorMessage(error),
      evidence: { descriptorUrl: url },
    };
  }
  if (
    !isRecord(descriptor) ||
    descriptor.schemaVersion !== 1 ||
    !Array.isArray(descriptor.archives)
  ) {
    return {
      kind: "source-server",
      valid: false,
      current: false,
      present: 0,
      total: targets.length,
      partial: false,
      detail: "descriptor 结构不合法",
      evidence: { descriptorUrl: url },
    };
  }

  const results = [];
  for (const target of targets) {
    const archive = descriptor.archives.find((item) => isRecord(item) && item.target === target);
    if (!archive) {
      results.push({ target, state: "absent", detail: "descriptor 缺少 target" });
      continue;
    }
    if (
      typeof archive.fileName !== "string" ||
      !/^[A-Za-z0-9._-]+$/u.test(archive.fileName) ||
      !/^[a-f0-9]{64}$/u.test(String(archive.sha256 ?? "")) ||
      !Number.isSafeInteger(archive.sizeBytes) ||
      archive.sizeBytes <= 0 ||
      archive.version !== version
    ) {
      results.push({ target, state: "invalid", detail: "descriptor 条目字段不合法" });
      continue;
    }
    const archiveUrl = new URL(archive.fileName, url).toString();
    const probe = await probeUrl(archiveUrl, { fetchImpl, retries, timeoutMs });
    if (!probe.ok) {
      results.push({
        target,
        state: "absent",
        detail: probe.error ?? `HTTP ${probe.status}`,
        url: archiveUrl,
      });
      continue;
    }
    if (probe.size !== null && probe.size !== archive.sizeBytes) {
      results.push({
        target,
        state: "invalid",
        detail: `大小不符：期望 ${archive.sizeBytes}，实际 ${probe.size}`,
        url: archiveUrl,
      });
      continue;
    }
    if (deep) {
      try {
        const actual = await downloadAndHash(archiveUrl, {
          fetchImpl,
          retries,
          timeoutMs: 300_000,
        });
        if (actual !== archive.sha256) {
          results.push({
            target,
            state: "invalid",
            detail: `sha256 不符：期望 ${archive.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`,
            url: archiveUrl,
          });
          continue;
        }
      } catch (error) {
        results.push({
          target,
          state: "invalid",
          detail: `sha256 校验失败：${errorMessage(error)}`,
          url: archiveUrl,
        });
        continue;
      }
    }
    results.push({ target, state: "present", url: archiveUrl });
  }

  const present = results.filter((item) => item.state === "present").length;
  const invalid = results.filter((item) => item.state === "invalid");
  const descriptorVersion = typeof descriptor.version === "string" ? descriptor.version : null;
  const versionMatches = descriptorVersion === version;
  const valid = invalid.length === 0;
  const detailParts = [
    `descriptor ${versionMatches ? version : (descriptorVersion ?? "缺版本")}`,
    `${present}/${targets.length} 档案`,
  ];
  if (invalid.length > 0)
    detailParts.push(`结构异常：${invalid.map((item) => item.target).join(", ")}`);
  return {
    kind: "source-server",
    valid,
    current: versionMatches && present === targets.length && targets.length > 0,
    present,
    total: targets.length,
    partial: versionMatches && present > 0 && present < targets.length,
    detail: detailParts.join("；"),
    evidence: { descriptorUrl: url, descriptorVersion, archives: results },
  };
}

/**
 * 桌面端：更新 manifest 与官网下载库存都按平台核对。更新 manifest 有 files[]，
 * 下载库存有 downloads[]，两处都齐才算这个平台发布完成。
 */
export async function checkDesktop(artifact, { version, fetchImpl, retries, timeoutMs } = {}) {
  const { manifestUrl, downloadsUrl, channel = "stable", platforms = [] } = artifact.check;
  const results = await Promise.all(
    platforms.map(async (platform) => {
      const suffix = `?platform=${encodeURIComponent(platform)}&channel=${encodeURIComponent(channel)}`;
      try {
        const manifestResponse = await requestWithRetry(`${manifestUrl}${suffix}`, {
          fetchImpl,
          retries,
          timeoutMs,
          headers: { accept: "application/json" },
        });
        if (manifestResponse.status === 404) {
          return { platform, state: "absent", detail: "更新 manifest 404" };
        }
        if (!manifestResponse.ok) throw new Error(`更新 manifest HTTP ${manifestResponse.status}`);
        const manifest = await readJson(manifestResponse);
        const manifestVersion = typeof manifest?.version === "string" ? manifest.version : null;
        const files = Array.isArray(manifest?.files) ? manifest.files : [];
        const manifestComplete =
          manifestVersion === version &&
          files.length > 0 &&
          files.every(
            (file) =>
              isRecord(file) &&
              typeof file.url === "string" &&
              typeof file.sha512 === "string" &&
              file.sha512.length > 0,
          );

        let downloadsComplete = false;
        let downloadsVersion = null;
        let downloads = [];
        if (downloadsUrl) {
          const downloadsResponse = await requestWithRetry(`${downloadsUrl}${suffix}`, {
            fetchImpl,
            retries,
            timeoutMs,
            headers: { accept: "application/json" },
          });
          if (downloadsResponse.ok) {
            const payload = await readJson(downloadsResponse);
            downloadsVersion = typeof payload?.version === "string" ? payload.version : null;
            downloads = Array.isArray(payload?.downloads) ? payload.downloads : [];
            downloadsComplete =
              downloadsVersion === version &&
              downloads.length > 0 &&
              downloads.every((item) => isRecord(item) && typeof item.url === "string");
          } else if (downloadsResponse.status !== 404) {
            throw new Error(`下载库存 HTTP ${downloadsResponse.status}`);
          }
        }

        const partial =
          manifestVersion === version ||
          downloadsVersion === version ||
          (manifestComplete && !downloadsComplete);
        if (manifestComplete && downloadsComplete) {
          const assetUrls = [
            ...new Set([
              ...files.map((file) => file.url),
              ...downloads.map((download) => download.url),
            ]),
          ];
          const probes = await Promise.all(
            assetUrls.map(async (rawUrl) => {
              let url;
              try {
                url = new URL(rawUrl, manifestUrl).toString();
              } catch {
                return { url: rawUrl, ok: false, detail: "URL 不合法" };
              }
              const probe = await probeUrl(url, { fetchImpl, retries, timeoutMs });
              return { url, ...probe };
            }),
          );
          const unreachable = probes.filter((probe) => !probe.ok);
          if (unreachable.length > 0) {
            return {
              platform,
              state: "absent",
              version: manifestVersion,
              detail: `下载件不可达：${unreachable.map((probe) => probe.url).join(", ")}`,
              partial: true,
            };
          }
          return { platform, state: "present", version: manifestVersion, assets: probes.length };
        }
        return {
          platform,
          state: "absent",
          version: manifestVersion,
          detail: manifestComplete
            ? "更新 manifest 已就绪，下载库存缺件"
            : `更新 manifest ${manifestVersion ?? "缺版本"}`,
          partial,
        };
      } catch (error) {
        return { platform, state: "error", detail: errorMessage(error) };
      }
    }),
  );

  const present = results.filter((item) => item.state === "present").length;
  const errors = results.filter((item) => item.state === "error");
  const partial = results.some((item) => item.partial);
  const versions = [...new Set(results.map((item) => item.version).filter(Boolean))];
  const valid = errors.length === 0;
  const detailParts = [`${present}/${platforms.length} 平台`];
  if (versions.length > 0) detailParts.push(`线上 ${versions.join("/")}`);
  if (errors.length > 0) detailParts.push(`查询失败：${errors.length} 个平台`);
  return {
    kind: "desktop",
    valid,
    current: present === platforms.length && platforms.length > 0,
    present,
    total: platforms.length,
    partial: partial || present > 0,
    detail: detailParts.join("；"),
    evidence: { platforms: results },
  };
}

export async function checkArtifact(artifact, options = {}) {
  switch (artifact.check.kind) {
    case "npm":
      return checkNpm(artifact, options);
    case "source-server":
      return checkSourceServer(artifact, options);
    case "desktop":
      return checkDesktop(artifact, options);
    case "web-release":
      return checkWebRelease(artifact, options);
    case "plugin-market":
      return checkPluginMarket(artifact, options);
    default:
      throw new Error(`unknown artifact check kind: ${artifact.check.kind}`);
  }
}
