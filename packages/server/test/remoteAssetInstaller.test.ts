import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildRemoteArtifactDownloadCommand,
  buildRemoteChecksumCommand,
} from "@nibi/server/remote/remoteAssetInstaller.js";
import type { RemoteSha256Tool } from "@nibi/server/remote/remoteAssetPreflight.js";

const execFileAsync = promisify(execFile);
const localShellCommand = resolveLocalShellCommand();
const shellBackedIt = localShellCommand ? it : it.skip;

function resolveLocalShellCommand(): string | null {
  if (process.platform !== "win32") {
    return "sh";
  }

  const gitShellCandidates = [
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "sh.exe"),
    join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "usr", "bin", "sh.exe"),
  ];
  return gitShellCandidates.find((candidate) => existsSync(candidate)) ?? null;
}

function toLocalShellPath(filePath: string): string {
  if (process.platform !== "win32") {
    return filePath;
  }

  // Bugfix: Git Bash 的 sha256sum 读取 C:\... 这类反斜杠路径时，会为了转义文件名在校验值前输出反斜杠，
  // 导致测试误判为 sha mismatch。远端真实路径是 POSIX 风格，这里把 Windows 临时路径转成 /c/... 来贴近远端形态。
  const normalized = filePath.replaceAll("\\", "/");
  return normalized.replace(
    /^([A-Za-z]):\//u,
    (_match, drive: string) => `/${drive.toLowerCase()}/`,
  );
}

async function detectLocalShellSha256Tool(shellCommand: string): Promise<RemoteSha256Tool> {
  // Bugfix: Windows Git Bash 环境常有 sha256sum/openssl 但没有 shasum；测试硬编码 shasum
  // 会让“备用 URL 校验失败后重试”的用例在真正执行到重试逻辑前就失败。
  const { stdout } = await execFileAsync(shellCommand, [
    "-c",
    "if command -v sha256sum >/dev/null 2>&1; then printf sha256sum; elif command -v shasum >/dev/null 2>&1; then printf shasum; elif command -v openssl >/dev/null 2>&1; then printf openssl; else exit 1; fi",
  ]);
  const tool = stdout.trim();
  if (tool === "sha256sum" || tool === "shasum" || tool === "openssl") {
    return tool;
  }
  throw new Error(`unsupported local sha256 tool: ${tool}`);
}

describe("remote asset installer command builders", () => {
  it("quotes remote paths and URLs in download commands", () => {
    const command = buildRemoteArtifactDownloadCommand({
      tool: "curl",
      urls: ["https://cdn.example.test/a b/component.tar.gz"],
      outputPath: "~/.nibi/server/asset-cache/staging/a b/component.tar.gz",
      progressLabel: "server-bundle@1.0.0-server-bundle",
    });

    expect(command).toContain("curl");
    expect(command).toContain("'https://cdn.example.test/a b/component.tar.gz'");
    expect(command).toContain("\"$HOME\"'/.nibi/server/asset-cache/staging/a b/component.tar.gz'");
  });

  it("emits remote download progress lines while downloading artifacts", () => {
    const command = buildRemoteArtifactDownloadCommand({
      tool: "wget",
      urls: ["https://cdn.example.test/component.tar.gz"],
      outputPath: "~/.nibi/server/asset-cache/staging/component.tar.gz",
      progressLabel: "server-bundle@1.0.0-server-bundle",
    });

    expect(command).toContain("download progress: [%s]");
    expect(command).toContain("label='server-bundle@1.0.0-server-bundle'");
    expect(command).toContain("total unknown");
    expect(command).toContain("progress_pid=");
    expect(command).toContain('kill "$progress_pid"');
  });

  it("emits remote download percent when artifact size is known", () => {
    const command = buildRemoteArtifactDownloadCommand({
      tool: "wget",
      urls: ["https://cdn.example.test/component.tar.gz"],
      outputPath: "~/.nibi/server/asset-cache/staging/component.tar.gz",
      progressLabel: "server-bundle@1.0.0-server-bundle",
      totalBytes: 2 * 1024 * 1024,
    });

    expect(command).toContain("total=2097152");
    expect(command).toContain("download progress: [%s] %.1f%%");
    expect(command).toContain("%.1f/%.1f MB");
    expect(command).not.toContain("total unknown");
  });

  it("downloads without optional progress tools on minimal remote hosts", () => {
    const command = buildRemoteArtifactDownloadCommand({
      tool: "curl",
      urls: ["https://cdn.example.test/component.tar.gz"],
      outputPath: "~/.nibi/server/component.tar.gz",
      progressLabel: "source-server-linux-x64",
      supportsProgress: false,
    });

    expect(command).toContain("curl -fL");
    expect(command).not.toContain("progress_pid=");
    expect(command).not.toContain("awk ");
    expect(command).not.toContain("wc -c");
    expect(command).not.toContain("date +%s");
  });

  shellBackedIt(
    "tries the next artifact URL when a downloaded candidate fails sha256 validation",
    async () => {
      const shellCommand = localShellCommand ?? "sh";
      const dir = await mkdtemp(join(tmpdir(), "nibi-installer-download-"));
      const badArchive = join(dir, "bad.tar.gz");
      const goodArchive = join(dir, "good.tar.gz");
      const outputPath = join(dir, "component.tar.gz");
      const shellOutputPath = toLocalShellPath(outputPath);
      await writeFile(badArchive, "stale artifact");
      await writeFile(goodArchive, "current artifact");
      const expectedSha256 = createHash("sha256").update("current artifact").digest("hex");

      const command = buildRemoteArtifactDownloadCommand({
        tool: "curl",
        urls: [pathToFileURL(badArchive).href, pathToFileURL(goodArchive).href],
        outputPath: shellOutputPath,
        progressLabel: "node-runtime@v22.23.4",
        expectedSha256,
        sha256Tool: await detectLocalShellSha256Tool(shellCommand),
        supportsProgress: false,
      });

      await execFileAsync(shellCommand, ["-c", command]);

      await expect(readFile(outputPath, "utf8")).resolves.toBe("current artifact");
    },
  );

  it("builds sha256 commands for openssl", () => {
    const command = buildRemoteChecksumCommand({
      tool: "openssl",
      filePath: "~/.nibi/server/component.tar.gz",
    });
    expect(command).toContain("openssl dgst -sha256");
    expect(command).not.toContain("awk");
  });
});
