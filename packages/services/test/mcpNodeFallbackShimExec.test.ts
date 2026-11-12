import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMcpNodeFallbackHostEnv,
  MCP_NODE_FALLBACK_EXEC_PATH_ENV_KEY,
  MCP_NODE_FALLBACK_NPM_ROOT_ENV_KEY,
} from "../src/zcode-agent/mcpNodeFallback/index.js";

/**
 * 端到端钉住「没有系统 Node 时 MCP 子进程怎么找到 node」：这里生成的是真实 shim 文件，
 * 并用与生产一致的方式执行它（Windows 上 `.cmd` 只能经 cmd.exe /d /s /c；POSIX 上直接按
 * PATH 解析 shebang 脚本）。断言只看子进程事实：退出码、stdout/stderr、以及 PATH 上到底
 * 还能解析到哪个 node。
 *
 * Windows 侧对应 Rust 内核 kernel/crates/env-local/src/mcp/stdio.rs 的 resolve + plan，
 * POSIX 侧对应系统 execvp 按 PATH 顺序解析。两边的前提都是 shim 目录追加在 PATH 末尾。
 */
const isWindows = process.platform === "win32";
const tempRoots: string[] = [];

interface RunResult {
  code: number | null;
  stderr: string;
  stdout: string;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/** 路径故意带空格：桌面安装目录、工作区、用户 npm 路径都可能是这种形态。 */
async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nibi mcp fallback "));
  tempRoots.push(root);
  return root;
}

function normalizePath(value: string): string {
  const withoutTrailingSeparators = value.replace(/[\\/]+$/, "");
  return isWindows
    ? withoutTrailingSeparators.replaceAll("/", "\\").toLowerCase()
    : withoutTrailingSeparators;
}

/** 生产环境里 `Path` 已经由 buildCleanEnv 统一成大写 `PATH`；这里给 Windows 用 TitleCase 更接近 process.env 的真实形态。 */
function pathEnvKey(): string {
  return isWindows ? "Path" : "PATH";
}

/** “用户机器没装 Node”：Windows 只有 System32（本机实测无 node.exe/node.cmd）；POSIX 用不存在的目录。 */
function pathWithoutNode(): string {
  return isWindows
    ? join(process.env.SystemRoot ?? "C:\\Windows", "System32")
    : join(tmpdir(), "nibi-node-fallback-empty-path");
}

function baseEnv(pathValue: string): Record<string, string> {
  const env: Record<string, string> = { PATH: pathValue };
  if (isWindows) {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    env.SystemRoot = systemRoot;
    env.ComSpec = process.env.ComSpec ?? join(systemRoot, "System32", "cmd.exe");
    env.PATHEXT = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
    env.TEMP = process.env.TEMP ?? tmpdir();
    env.TMP = process.env.TMP ?? tmpdir();
    env.USERPROFILE = process.env.USERPROFILE ?? tmpdir();
  }
  return env;
}

function run(
  command: string,
  args: string[],
  env: Record<string, string | undefined>,
  windowsVerbatimArguments = false,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true, windowsVerbatimArguments });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr, stdout }));
  });
}

/**
 * 按生产口径执行 `node <script>`：
 * - Windows：`.cmd` 不能被 CreateProcess 直接启动，Rust 内核的 node_fallback::plan 用
 *   `cmd.exe /d /s /c`；这里用同样的入口，并让 cmd 自己按 PATH + PATHEXT 解析 `node`。
 *   外层再包一对引号 + windowsVerbatimArguments 是 cmd /s /c 的既定协议（Node 的
 *   `shell: true` 与 cross-spawn 都这样做），否则参数里的空格会被拆开。
 * - POSIX：/bin/sh 按 PATH 顺序解析 `node`，找到 shim（shebang #!/bin/sh）后执行；这也避免
 *   依赖 libuv 对 spawn 时 PATH 的查找口径。
 */
async function runNodeScript(
  scriptPath: string,
  env: Record<string, string | undefined>,
): Promise<RunResult> {
  if (isWindows) {
    const comspec = env.ComSpec ?? process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
    return run(comspec, ["/d", "/s", "/c", `"node "${scriptPath}""`], env, true);
  }
  return run("/bin/sh", ["-c", 'exec node "$1"', "sh", scriptPath], env);
}

async function runNpm(args: string[], env: Record<string, string | undefined>): Promise<RunResult> {
  if (isWindows) {
    const comspec = env.ComSpec ?? process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe";
    return run(comspec, ["/d", "/s", "/c", `"npm ${args.join(" ")}"`], env, true);
  }
  return run("/bin/sh", ["-c", 'exec npm "$@"', "sh", ...args], env);
}

/** PATH/PATHEXT 语义下的“哪个 node 会被先执行”。Windows 大小写不敏感，靠 existsSync 命中。 */
function findExecutableOnPath(command: string, pathValue: string): string | undefined {
  const extensions = isWindows
    ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const entry of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(entry, `${command}${isWindows ? extension.toLowerCase() : ""}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

async function writeFakeNpmPackage(root: string): Promise<string> {
  const npmRoot = join(root, "bundled npm");
  await mkdir(join(npmRoot, "bin"), { recursive: true });
  const reporter = `process.stdout.write(JSON.stringify({
  npmRoot: process.env.${MCP_NODE_FALLBACK_NPM_ROOT_ENV_KEY} ?? null,
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  args: process.argv.slice(2)
}));\n`;
  await writeFile(join(npmRoot, "bin", "npm-cli.js"), reporter);
  await writeFile(join(npmRoot, "bin", "npx-cli.js"), reporter);
  return npmRoot;
}

async function writeReporterScript(root: string): Promise<string> {
  const directory = join(root, "scripts with spaces");
  await mkdir(directory, { recursive: true });
  const scriptPath = join(directory, "report exec path.js");
  await writeFile(
    scriptPath,
    `process.stdout.write(JSON.stringify({
  execPath: process.execPath,
  electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
  script: process.argv[1] ?? null,
  args: process.argv.slice(2)
}));\n`,
  );
  return scriptPath;
}

async function buildFallback(root: string, basePath: string) {
  const npmRoot = await writeFakeNpmPackage(root);
  const env = await buildMcpNodeFallbackHostEnv({
    kernel: "rust",
    isElectron: true,
    execPath: process.execPath,
    npmRootCandidates: [npmRoot],
    platform: process.platform,
    processEnv: { [pathEnvKey()]: basePath },
    storageRoot: root,
  });
  return { binDir: join(root, "node-fallback", "v1"), env, npmRoot };
}

describe("generated MCP node fallback shim (end to end)", () => {
  it("runs the injected executable when PATH has no node anywhere except the shim, and forwards args with spaces", async () => {
    const root = await makeTempRoot();
    const scriptPath = await writeReporterScript(root);
    const basePath = pathWithoutNode();
    const { binDir, env, npmRoot } = await buildFallback(root, basePath);
    const childEnv: Record<string, string | undefined> = { ...baseEnv(basePath), ...env };

    expect(childEnv[MCP_NODE_FALLBACK_EXEC_PATH_ENV_KEY]).toBe(process.execPath);
    expect(childEnv[MCP_NODE_FALLBACK_NPM_ROOT_ENV_KEY]).toBe(npmRoot);

    const pathEntries = (childEnv.PATH ?? "").split(delimiter).filter(Boolean);
    expect(normalizePath(pathEntries.at(-1)!)).toBe(normalizePath(binDir));
    // 唯一能被解析到的 node 是 shim 自己；shim 之前的目录里没有 node。
    expect(normalizePath(findExecutableOnPath("node", childEnv.PATH!)!)).toBe(
      normalizePath(join(binDir, isWindows ? "node.cmd" : "node")),
    );
    for (const entry of pathEntries.slice(0, -1)) {
      expect(existsSync(join(entry, isWindows ? "node.exe" : "node"))).toBe(false);
    }

    const result = await runNodeScript(scriptPath, childEnv);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      args: string[];
      electronRunAsNode: string | null;
      execPath: string;
      script: string | null;
    };
    // 子进程实际跑的可执行文件就是注入的那个（Windows 上 process.execPath 含空格）。
    expect(await realpath(report.execPath)).toBe(await realpath(process.execPath));
    // 含空格的脚本路径原样穿过 cmd.exe → shim → node，没有被拆成两个参数。
    expect(report.script).toBe(scriptPath);
    expect(report.args).toEqual([]);
    expect(report.electronRunAsNode).toBe("1");

    // npm 同理走 `%NIBI_NODE_FALLBACK_NPM_ROOT%\bin\npm-cli.js`，根目录含空格也必须能执行。
    const npm = await runNpm(["--version"], childEnv);
    expect(npm.stderr).toBe("");
    expect(npm.code).toBe(0);
    const npmReport = JSON.parse(npm.stdout) as {
      args: string[];
      electronRunAsNode: string | null;
      npmRoot: string | null;
    };
    expect(npmReport.npmRoot).toBe(npmRoot);
    expect(npmReport.args).toEqual(["--version"]);
    expect(npmReport.electronRunAsNode).toBe("1");
  });

  it("exits 127 with the documented diagnostic when the exec path is missing", async () => {
    const root = await makeTempRoot();
    const scriptPath = await writeReporterScript(root);
    const basePath = pathWithoutNode();
    const { env } = await buildFallback(root, basePath);
    delete env[MCP_NODE_FALLBACK_EXEC_PATH_ENV_KEY];
    const childEnv: Record<string, string | undefined> = { ...baseEnv(basePath), ...env };

    const result = await runNodeScript(scriptPath, childEnv);

    expect(result.code).toBe(127);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      `nibi node fallback: ${MCP_NODE_FALLBACK_EXEC_PATH_ENV_KEY} is not set`,
    );
  });

  it("exits 127 with the npm-root diagnostic when npm/npx run without a bundled npm", async () => {
    const root = await makeTempRoot();
    const basePath = pathWithoutNode();
    const env = await buildMcpNodeFallbackHostEnv({
      kernel: "rust",
      isElectron: true,
      execPath: process.execPath,
      npmRootCandidates: [],
      platform: process.platform,
      processEnv: { [pathEnvKey()]: basePath },
      storageRoot: root,
    });
    const childEnv: Record<string, string | undefined> = { ...baseEnv(basePath), ...env };
    expect(childEnv[MCP_NODE_FALLBACK_NPM_ROOT_ENV_KEY]).toBeUndefined();

    const result = await runNpm(["--version"], childEnv);

    expect(result.code).toBe(127);
    expect(result.stderr).toContain(
      `nibi node fallback: ${MCP_NODE_FALLBACK_NPM_ROOT_ENV_KEY} is not set`,
    );
  });

  it("keeps the user's own node on PATH ahead of the shim (it runs even without the fallback env)", async () => {
    const root = await makeTempRoot();
    const userBin = join(root, "user node bin");
    await mkdir(userBin, { recursive: true });
    const userNode = join(userBin, isWindows ? "node.cmd" : "node");
    if (isWindows) {
      await writeFile(userNode, "@echo off\r\necho USER_NODE_FROM_PATH\r\n");
    } else {
      await writeFile(userNode, "#!/bin/sh\necho USER_NODE_FROM_PATH\n", { mode: 0o755 });
      await chmod(userNode, 0o755);
    }
    const basePath = [userBin, pathWithoutNode()].join(delimiter);
    const { env } = await buildFallback(root, basePath);
    const childEnv: Record<string, string | undefined> = { ...baseEnv(basePath), ...env };
    // 用户自己的 node 在前：即使没有回退变量，也必须成功（证明 shim 根本没被执行）。
    delete childEnv[MCP_NODE_FALLBACK_EXEC_PATH_ENV_KEY];

    expect(normalizePath(findExecutableOnPath("node", childEnv.PATH!)!)).toBe(
      normalizePath(userNode),
    );

    const result = await runNodeScript("unused-report.js", childEnv);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("USER_NODE_FROM_PATH");
  });

  it("does not touch a real user node binary ahead of the shim", async () => {
    const root = await makeTempRoot();
    const scriptPath = await writeReporterScript(root);
    // PATH 最前面就是本机真实的 Node；shim 在最后。真 node 优先时不会被设置
    // ELECTRON_RUN_AS_NODE（那是 shim 才会加的），也不会因为缺少回退变量而失败。
    const basePath = [dirname(process.execPath), pathWithoutNode()].join(delimiter);
    const { env } = await buildFallback(root, basePath);
    const childEnv: Record<string, string | undefined> = { ...baseEnv(basePath), ...env };
    delete childEnv[MCP_NODE_FALLBACK_EXEC_PATH_ENV_KEY];

    const result = await runNodeScript(scriptPath, childEnv);

    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout) as {
      electronRunAsNode: string | null;
      execPath: string;
      script: string | null;
    };
    expect(await realpath(report.execPath)).toBe(await realpath(process.execPath));
    expect(report.script).toBe(scriptPath);
    expect(report.electronRunAsNode).toBeNull();
  });
});
