import { quotePosixPathArg, quotePosixShellArg } from "@nibi/server/remote/posixShell.js";
import type {
  RemoteDownloadTool,
  RemoteSha256Tool,
} from "@nibi/server/remote/remoteAssetPreflight.js";

/**
 * Source Server release 下载脚本构造器。
 *
 * 远端只执行这一条 shell 命令完成下载、逐 URL 回退、sha256 校验与进度输出；
 * 本模块不持有任何安装器状态，也不再包含 R2 组件安装链。
 */
export function buildRemoteArtifactDownloadCommand(params: {
  tool: RemoteDownloadTool;
  urls: string[];
  outputPath: string;
  progressLabel: string;
  totalBytes?: number | null;
  expectedSha256?: string;
  sha256Tool?: RemoteSha256Tool;
  supportsProgress?: boolean;
}): string {
  const shouldVerifyChecksum =
    typeof params.expectedSha256 === "string" &&
    params.expectedSha256.length > 0 &&
    typeof params.sha256Tool === "string";
  const attempts = params.urls.map((url) => {
    const quotedOutputPath = quotePosixPathArg(params.outputPath);
    if (params.tool === "curl") {
      return buildRemoteArtifactDownloadAttempt({
        downloadCommand: `curl -fL --retry 2 --connect-timeout 20 -o ${quotedOutputPath} ${quotePosixPathArg(url)}`,
        outputPath: params.outputPath,
        progressLabel: params.progressLabel,
        expectedSha256: shouldVerifyChecksum ? params.expectedSha256 : undefined,
        sha256Tool: shouldVerifyChecksum ? params.sha256Tool : undefined,
      });
    }
    return buildRemoteArtifactDownloadAttempt({
      downloadCommand: `wget --tries=3 --timeout=20 -O ${quotedOutputPath} ${quotePosixPathArg(url)}`,
      outputPath: params.outputPath,
      progressLabel: params.progressLabel,
      expectedSha256: shouldVerifyChecksum ? params.expectedSha256 : undefined,
      sha256Tool: shouldVerifyChecksum ? params.sha256Tool : undefined,
    });
  });
  return buildRemoteDownloadWithProgressCommand({
    attemptCommand: attempts.map((attempt) => `(${attempt})`).join(" || "),
    outputPath: params.outputPath,
    progressLabel: params.progressLabel,
    totalBytes: params.totalBytes,
    supportsProgress: params.supportsProgress !== false,
  });
}

function buildRemoteArtifactDownloadAttempt(params: {
  downloadCommand: string;
  outputPath: string;
  progressLabel: string;
  expectedSha256?: string;
  sha256Tool?: RemoteSha256Tool;
}): string {
  if (!params.expectedSha256 || !params.sha256Tool) {
    return params.downloadCommand;
  }

  const checksumCommand = buildRemoteChecksumCommand({
    tool: params.sha256Tool,
    filePath: params.outputPath,
  });
  const quotedOutputPath = quotePosixPathArg(params.outputPath);
  const quotedExpectedSha256 = quotePosixShellArg(params.expectedSha256);
  const mismatchPrefix = quotePosixShellArg(
    `[remote-assets] sha256 mismatch for ${params.progressLabel}: expected=${params.expectedSha256}, actual=`,
  );

  // 多 CDN 发布存在短暂不一致时，首个 URL 可能能下载但 sha 指向旧对象。
  // 把校验放进每个候选 URL 的尝试块里，才能在 mismatch 后继续尝试备用 CDN。
  return [
    `rm -f ${quotedOutputPath}`,
    params.downloadCommand,
    `actual_sha=$(${checksumCommand})`,
    `if [ "$actual_sha" = ${quotedExpectedSha256} ]; then true; else echo ${mismatchPrefix}"$actual_sha" >&2; false; fi`,
  ].join(" && ");
}

function buildRemoteDownloadWithProgressCommand(params: {
  attemptCommand: string;
  outputPath: string;
  progressLabel: string;
  totalBytes?: number | null;
  supportsProgress: boolean;
}): string {
  if (!params.supportsProgress) return params.attemptCommand;
  const quotedOutputPath = quotePosixPathArg(params.outputPath);
  const quotedProgressLabel = quotePosixShellArg(params.progressLabel);
  const totalBytes = normalizeTotalBytes(params.totalBytes);
  const progressPrinter =
    totalBytes != null
      ? `awk -v label=${quotedProgressLabel} -v bytes="$progress_size" -v total=${totalBytes} -v elapsed="$progress_elapsed" 'BEGIN { transferred = bytes / 1048576; total_mb = total / 1048576; speed = transferred / elapsed; percent = bytes / total * 100; if (percent > 100) percent = 100; printf "download progress: [%s] %.1f%% (%.1f/%.1f MB, %.2f MB/s)\\n", label, percent, transferred, total_mb, speed; fflush(); }'`
      : `awk -v label=${quotedProgressLabel} -v bytes="$progress_size" -v elapsed="$progress_elapsed" 'BEGIN { transferred = bytes / 1048576; speed = transferred / elapsed; printf "download progress: [%s] %.1f MB (total unknown, %.2f MB/s)\\n", label, transferred, speed; fflush(); }'`;
  const updateProgressVars = `if [ -f ${quotedOutputPath} ]; then progress_size=$(wc -c < ${quotedOutputPath} 2>/dev/null || printf 0); else progress_size=0; fi; progress_now=$(date +%s); progress_elapsed=$((progress_now - progress_started_at)); if [ "$progress_elapsed" -le 0 ]; then progress_elapsed=1; fi`;
  const progressLoop = `progress_started_at=$(date +%s); progress_pid=; (last_progress_size=-1; while :; do ${updateProgressVars}; if [ "$progress_size" != "$last_progress_size" ]; then ${progressPrinter}; last_progress_size="$progress_size"; fi; sleep 1; done) & progress_pid=$!`;
  const stopProgressLoop = `if [ -n "$progress_pid" ]; then kill "$progress_pid" >/dev/null 2>&1 || true; wait "$progress_pid" 2>/dev/null || true; fi; if [ -f ${quotedOutputPath} ]; then ${updateProgressVars}; ${progressPrinter}; fi`;

  // 远端服务器下载以前只等 wget/curl 结束，连接窗口没有速度和进度反馈。
  // 这里不依赖 wget/curl 各自不稳定的进度条，而是在远端按目标文件大小节流输出统一格式，
  // 连接窗口可以复用现有 download progress 合并逻辑展示最新速度。
  return `set +e; ${progressLoop}; ${params.attemptCommand}; download_status=$?; set -e; ${stopProgressLoop}; test "$download_status" -eq 0`;
}

function normalizeTotalBytes(totalBytes: number | null | undefined): number | null {
  if (typeof totalBytes !== "number" || !Number.isFinite(totalBytes)) {
    return null;
  }
  const normalized = Math.floor(totalBytes);
  return normalized > 0 ? normalized : null;
}

export function buildRemoteChecksumCommand(params: {
  tool: RemoteSha256Tool;
  filePath: string;
}): string {
  const file = quotePosixPathArg(params.filePath);
  if (params.tool === "sha256sum") {
    return `checksum_output=$(sha256sum ${file}) && printf '%s' "\${checksum_output%% *}"`;
  }
  if (params.tool === "shasum") {
    return `checksum_output=$(shasum -a 256 ${file}) && printf '%s' "\${checksum_output%% *}"`;
  }
  return `checksum_output=$(openssl dgst -sha256 ${file}) && printf '%s' "\${checksum_output##* }"`;
}
