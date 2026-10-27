import { normalizeRemoteConnectionError } from "@nibi/shared";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import {
  SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  NIBI_VERSION,
  normalizeRemoteAssetInstallMode,
  sourceServerReleaseDescriptorSchema,
  type RemoteTarget,
  type SourceServerReleaseArchive,
  type SourceServerReleaseDescriptor,
} from "@nibi/shared";
import {
  buildReleaseAssetUrlCandidates,
  buildReleaseBaseCandidates,
} from "@nibi/server/remote/remoteAssetCdn.js";
import {
  resolveRemoteAssetFetch,
  type RemoteAssetNetworkPort,
} from "@nibi/server/remote/remoteAssetNetwork.js";
import type { ServerReleaseAsset, SourceServerProbeResult } from "@nibi/server/source-server";
import type { WindowRemoteAssetDirs } from "./windowRemoteConnectionRegistry.js";

interface ResolvedDescriptor {
  descriptor: SourceServerReleaseDescriptor;
  releaseBases: string[];
}

async function pathExists(path: string): Promise<boolean> {
  return await access(path).then(
    () => true,
    () => false,
  );
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyArchive(path: string, archive: SourceServerReleaseArchive): Promise<boolean> {
  const fileStat = await stat(path).catch(() => null);
  if (!fileStat?.isFile() || fileStat.size !== archive.sizeBytes) return false;
  return (await sha256File(path)) === archive.sha256;
}

function readDescriptor(text: string): SourceServerReleaseDescriptor {
  const descriptor = sourceServerReleaseDescriptorSchema.parse(JSON.parse(text));
  if (descriptor.version !== NIBI_VERSION) {
    throw new Error(
      `Source Server descriptor version mismatch: expected ${NIBI_VERSION}, received ${descriptor.version}`,
    );
  }
  return descriptor;
}

function findArchive(
  descriptor: SourceServerReleaseDescriptor,
  target: string,
): SourceServerReleaseArchive {
  const archive = descriptor.archives.find((candidate) => candidate.target === target);
  if (!archive) throw new Error(`Source Server descriptor is missing target: ${target}`);
  return archive;
}

function resolveArchiveUrls(releaseBases: string[], archive: SourceServerReleaseArchive): string[] {
  const absolute = archive.urls.filter((url) => /^https?:\/\//u.test(url));
  const relative = archive.urls.filter((url) => !/^https?:\/\//u.test(url));
  return Array.from(
    new Set([...absolute, ...buildReleaseAssetUrlCandidates(releaseBases, relative)]),
  );
}

async function writeTextAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function resolveLocalDescriptor(
  releaseDir: string,
  target: string,
): Promise<{ archive: SourceServerReleaseArchive; archivePath: string } | null> {
  const descriptorPath = join(releaseDir, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME);
  if (!(await pathExists(descriptorPath))) return null;
  const descriptor = readDescriptor(await readFile(descriptorPath, "utf8"));
  const archive = findArchive(descriptor, target);
  const archivePath = join(releaseDir, archive.fileName);
  if (!(await verifyArchive(archivePath, archive))) {
    throw new Error(`Source Server local archive failed descriptor verification: ${archivePath}`);
  }
  return { archive, archivePath };
}

async function resolveRemoteDescriptor(
  remoteAssets: WindowRemoteAssetDirs,
  cacheRoot: string | null,
  remoteAssetNetwork?: RemoteAssetNetworkPort,
): Promise<ResolvedDescriptor> {
  const remoteCdnBaseUrls =
    remoteAssets.remoteCdnBaseUrls ??
    (remoteAssets.remoteCdnBaseUrl ? [remoteAssets.remoteCdnBaseUrl] : []);
  // 没有下载源不是"网络失败"，是**这个构建没配下载源**。两者对用户的含义完全不同：
  // 前者值得重试，后者重试多少次都不会好。必须给出能直接指向原因的文案。
  if (remoteCdnBaseUrls.length === 0) {
    throw new Error(
      "远端资源下载源未配置：本次构建没有注入 CDN 域名（CDN_DOMAIN），" +
        "也没有设置 NIBI_REMOTE_ASSET_CDN_BASE_URL。远端工作区不可用，本地功能不受影响。",
    );
  }
  const releaseBases = buildReleaseBaseCandidates(remoteCdnBaseUrls, NIBI_VERSION);
  const descriptorUrls = buildReleaseAssetUrlCandidates(releaseBases, [
    SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME,
  ]);
  const cachedDescriptorPath = cacheRoot
    ? join(cacheRoot, SOURCE_SERVER_RELEASE_DESCRIPTOR_FILE_NAME)
    : null;
  let lastError: unknown;
  const fetchImpl = resolveRemoteAssetFetch(remoteAssetNetwork);
  for (const url of descriptorUrls) {
    try {
      const response = await fetchImpl(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const descriptor = readDescriptor(text);
      if (cachedDescriptorPath) await writeTextAtomic(cachedDescriptorPath, text);
      return { descriptor, releaseBases };
    } catch (error) {
      lastError = error;
    }
  }
  if (cachedDescriptorPath && (await pathExists(cachedDescriptorPath))) {
    return {
      descriptor: readDescriptor(await readFile(cachedDescriptorPath, "utf8")),
      releaseBases,
    };
  }
  throw new Error("Unable to resolve Source Server release descriptor", { cause: lastError });
}

async function downloadArchive(
  archive: SourceServerReleaseArchive,
  urls: string[],
  cacheRoot: string,
  remoteAssetNetwork?: RemoteAssetNetworkPort,
): Promise<string> {
  await mkdir(cacheRoot, { recursive: true });
  const cached = join(cacheRoot, archive.fileName);
  if (await verifyArchive(cached, archive)) return cached;
  await rm(cached, { force: true });
  let lastError: unknown;
  const fetchImpl = resolveRemoteAssetFetch(remoteAssetNetwork);
  for (const url of urls) {
    const temporary = `${cached}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const response = await fetchImpl(url);
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(
        Readable.fromWeb(response.body as never),
        createWriteStream(temporary, { mode: 0o600 }),
      );
      if (!(await verifyArchive(temporary, archive))) {
        throw new Error(`Source Server archive checksum mismatch: ${archive.fileName}`);
      }
      await rename(temporary, cached);
      return cached;
    } catch (error) {
      lastError = error;
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  throw new Error(`Unable to download Source Server release ${archive.fileName}`, {
    cause: lastError,
  });
}

export async function resolveSourceServerReleaseAsset(
  ...args: Parameters<typeof resolveReleaseAsset>
): Promise<ServerReleaseAsset> {
  try {
    return await resolveReleaseAsset(...args);
  } catch (error) {
    const failure = normalizeRemoteConnectionError(error, "download");
    throw Object.assign(error instanceof Error ? error : new Error(failure.message), failure);
  }
}

async function resolveReleaseAsset(
  probe: SourceServerProbeResult,
  remoteAssets: WindowRemoteAssetDirs,
  remoteTarget: Exclude<RemoteTarget, { kind: "server" }>,
  remoteAssetNetwork?: RemoteAssetNetworkPort,
  options: { metadataOnly?: boolean } = {},
): Promise<ServerReleaseAsset> {
  if (
    (probe.platform !== "linux" && probe.platform !== "darwin") ||
    (probe.arch !== "x64" && probe.arch !== "arm64")
  ) {
    throw new Error(`Unsupported Source Server release target: ${probe.platform}-${probe.arch}`);
  }
  const target = `${probe.platform}-${probe.arch}`;
  const installMode =
    remoteTarget.kind === "ssh"
      ? normalizeRemoteAssetInstallMode(remoteTarget.assetInstallMode)
      : "local-download-upload";
  const cacheRoot = remoteAssets.remoteCacheDir
    ? join(remoteAssets.remoteCacheDir, "source-server", NIBI_VERSION)
    : null;

  if (
    remoteTarget.kind === "ssh" &&
    remoteAssets.sourceServerArtifactPolicy === "development-content-addressed"
  ) {
    if (!remoteAssets.mockCdnDir) {
      throw new Error(
        "Development Source Server release is unavailable; run pnpm bootstrap:with-remote",
      );
    }
    const releaseDir = join(remoteAssets.mockCdnDir, "releases", NIBI_VERSION);
    const local = await resolveLocalDescriptor(releaseDir, target);
    if (!local) {
      // Bug 原因：开发态回退 CDN 会把 bootstrap 失败伪装成连接成功，并继续运行同版本旧代码。
      // 内容寻址开发策略只能消费本轮本地 descriptor/archive，缺失时必须明确失败。
      throw new Error(
        "Development Source Server release descriptor is unavailable; run pnpm bootstrap:with-remote",
      );
    }
    return {
      localArchivePath: local.archivePath,
      target,
      version: NIBI_VERSION,
      sha256: local.archive.sha256,
      sizeBytes: local.archive.sizeBytes,
      urls: local.archive.urls,
    };
  }

  if (installMode === "local-download-upload") {
    // Bug 原因：开发态曾直接信任 gitignore 的 dist-release；同版本源码变化后仍会部署旧包。
    // 现在只接受本轮 staging 写入 mock-cdn 且通过 descriptor SHA/size 校验的本地产物。
    const localReleaseDirs = remoteAssets.mockCdnDir
      ? [join(remoteAssets.mockCdnDir, "releases", NIBI_VERSION)]
      : [];
    for (const releaseDir of localReleaseDirs) {
      const local = await resolveLocalDescriptor(releaseDir, target);
      if (!local) continue;
      return {
        localArchivePath: local.archivePath,
        target,
        version: NIBI_VERSION,
        sha256: local.archive.sha256,
        sizeBytes: local.archive.sizeBytes,
        urls: local.archive.urls,
      };
    }
  }

  const resolvedDescriptor = await resolveRemoteDescriptor(
    remoteAssets,
    cacheRoot,
    remoteAssetNetwork,
  );
  const archive = findArchive(resolvedDescriptor.descriptor, target);
  const urls = resolveArchiveUrls(resolvedDescriptor.releaseBases, archive);
  if (installMode === "remote-download" || options.metadataOnly) {
    return {
      target,
      version: NIBI_VERSION,
      sha256: archive.sha256,
      sizeBytes: archive.sizeBytes,
      urls,
    };
  }
  if (!cacheRoot)
    throw new Error(`Source Server release cache is unavailable: ${archive.fileName}`);
  return {
    localArchivePath: await downloadArchive(archive, urls, cacheRoot, remoteAssetNetwork),
    target,
    version: NIBI_VERSION,
    sha256: archive.sha256,
    sizeBytes: archive.sizeBytes,
    urls,
  };
}
