/**
 * Tier 2 第六批视觉证据的确定性夹具与进程定位。
 *
 * 只服务 `tier2-sixth-batch-evidence.test.ts`：
 * - 在隔离 HOME 里把 NibiProject 变成带一次 commit 的 Git 仓库（U06）。
 * - 以固定 sessionId 预置“来源会话/目标会话”两条真实 CLI 历史与 tasks-index 行（U30）；
 *   目标会话额外落 `metadata.conversationInputIntent.source`，由 Rust 冷加载投影成
 *   userInput row 的 source，而不是伪造 UI 行。
 * - 生成一张小 PNG 供 Markdown 图片预览使用（U27）。
 * - 找到并结束 Electron 主进程树里的 Rust agent runtime 子进程（U22）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deflateSync } from "node:zlib";
import { seedProviderReadinessHistoryFixture } from "./provider-readiness-history-fixture.js";

export const SIXTH_BATCH_SOURCE_SESSION_ID = "sess_e2e_sixth_source";
export const SIXTH_BATCH_SOURCE_TITLE = "Sixth Batch Source";
export const SIXTH_BATCH_TARGET_SESSION_ID = "sess_e2e_sixth_target";
export const SIXTH_BATCH_TARGET_TITLE = "Sixth Batch Target";
export const SIXTH_BATCH_MISSING_SESSION_ID = "sess_e2e_sixth_missing";
export const SIXTH_BATCH_SOURCE_REACHABLE_MARKER = "SIXTH_BATCH_SOURCE_REACHABLE";
export const SIXTH_BATCH_SOURCE_MISSING_MARKER = "SIXTH_BATCH_SOURCE_MISSING";
export const SIXTH_BATCH_IMAGE_FILENAME = "sixth-batch-image.png";
export const SIXTH_BATCH_DESIGN_FILENAME = "sixth-batch-design.html";

export interface SixthBatchSeedOptions {
  e2eHomeDir: string;
  workspacePath: string;
  providerId: string;
  modelId: string;
  thoughtLevel?: string;
}

function resolveCliEntryPoint(): string {
  const candidates = [
    process.env.NIBI_E2E_CLI_ENTRYPOINT?.trim(),
    resolve(process.cwd(), "../../apps/nibi-cli/packages/cli/dist/nibi.cjs"),
    resolve(process.cwd(), "apps/nibi-cli/packages/cli/dist/nibi.cjs"),
  ].filter((value): value is string => Boolean(value));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(
      `sixth-batch fixture 找不到 CLI entrypoint，检查过: ${candidates.join(", ")}`,
    );
  }
  return found;
}

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, env: process.env, stdio: "ignore" });
}

/** U06：Git 项目 + 一次 commit。重复调用时保持幂等。 */
export async function ensureSixthBatchGitWorkspace(workspacePath: string): Promise<void> {
  await mkdir(workspacePath, { recursive: true });
  // 隔离 HOME 位于主仓库工作树内，`git rev-parse` 会向上命中主仓库；必须只看本目录
  // 自己的 .git，否则 git add 会落到主仓库并被其 .gitignore 拒绝。
  if (!existsSync(join(workspacePath, ".git"))) {
    runGit(workspacePath, ["init"]);
  }
  runGit(workspacePath, ["checkout", "-B", "main"]);
  runGit(workspacePath, ["config", "user.name", "NIBI Sixth Batch E2E"]);
  runGit(workspacePath, ["config", "user.email", "nibi-sixth-batch@example.com"]);
  await writeFile(
    join(workspacePath, "README.md"),
    "Tier 2 sixth batch worktree evidence workspace.\n",
    "utf-8",
  );
  runGit(workspacePath, ["add", "README.md"]);
  try {
    runGit(workspacePath, ["commit", "-m", "chore: seed sixth batch e2e workspace"]);
  } catch {
    // 已有 commit（重复运行）时 `git commit` 以非零退出；仓库事实已经满足。
  }
}

export function readSixthBatchGitWorkspace(workspacePath: string): Record<string, unknown> {
  const result: Record<string, unknown> = {
    gitDirExists: existsSync(join(workspacePath, ".git")),
  };
  try {
    result.toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: workspacePath,
      encoding: "utf-8",
    }).trim();
    result.head = execFileSync("git", ["log", "--oneline", "-1"], {
      cwd: workspacePath,
      encoding: "utf-8",
    }).trim();
    result.status = execFileSync("git", ["status", "--short"], {
      cwd: workspacePath,
      encoding: "utf-8",
    }).trim();
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

/** U08：确认 Host 的官方插件 seed 是否写进隔离 HOME。 */
export function readPluginSeedState(e2eHomeDir: string): Record<string, unknown> {
  const root = join(e2eHomeDir, ".nibi", "cli", "plugins");
  const result: Record<string, unknown> = { exists: existsSync(root), root };
  if (!result.exists) return result;
  try {
    result.entries = readdirSync(root, { withFileTypes: true }).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "dir" : "file",
    }));
    const installedPath = join(root, "installed_plugins.json");
    if (existsSync(installedPath)) {
      result.installedPluginsJson = JSON.parse(readFileSync(installedPath, "utf-8")) as unknown;
    }
    const cacheRoot = join(root, "cache", "nibi-official");
    result.cacheEntries = existsSync(cacheRoot)
      ? readdirSync(cacheRoot, { withFileTypes: true }).map((entry) => entry.name)
      : [];
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/** 生成 160x96 的渐变 PNG；不依赖图形库，也不把大段 base64 塞进 fixture。 */
export function createSixthBatchPng(width = 160, height = 96): Buffer {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = y * stride + 1 + x * 4;
      raw[offset] = 40 + Math.round((120 * x) / width);
      raw[offset + 1] = 90 + Math.round((80 * y) / height);
      raw[offset + 2] = 180;
      raw[offset + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function writeSixthBatchImage(workspacePath: string): Promise<string> {
  const path = join(workspacePath, SIXTH_BATCH_IMAGE_FILENAME);
  await writeFile(path, createSixthBatchPng());
  return path;
}

function insertModelSelection(
  databasePath: string,
  sessionId: string,
  options: SixthBatchSeedOptions,
): void {
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare("delete from session_entry where session_id = ? and type = 'runtime/model_selection'")
      .run(sessionId);
    database
      .prepare(
        `insert into session_entry (id, session_id, type, time_created, time_updated, data)
         values (?, ?, 'runtime/model_selection', ?, ?, ?)`,
      )
      .run(
        `entry_model_${sessionId}`,
        sessionId,
        Date.now(),
        Date.now(),
        JSON.stringify({
          modelSelection: {
            providerId: options.providerId,
            modelId: options.modelId,
            ...(options.thoughtLevel
              ? { options: { reasoningLevel: options.thoughtLevel } }
              : {}),
          },
        }),
      );
  } finally {
    database.close();
  }
}

/**
 * Electron main 会把 NIBI_BUNDLED_AGENT_RESOURCE_DIR 覆盖成 bundled-agents/nibi，
 * 那里没有 packages/design-plugin；用同一份 CLI 在 App 退出窗口里显式跑一次
 * `plugins list`，把官方插件 seed 进隔离 HOME。只是准备夹具，不改产品代码。
 */
export function seedOfficialPluginsViaCli(options: {
  e2eHomeDir: string;
  workspacePath: string;
  /**
   * 显式指定官方插件资源根（包含 packages/*-plugin）。缺省仍优先继承环境变量，
   * 便于 source E2E 在 Host 覆盖成 bundled-agents/nibi 后强制回到仓库源目录。
   */
  resourceDir?: string;
  timeoutMs?: number;
}): void {
  const cliEntryPoint = resolveCliEntryPoint();
  const explicitResourceDir = options.resourceDir?.trim();
  if (explicitResourceDir && !existsSync(explicitResourceDir)) {
    throw new Error(`sixth-batch fixture 官方插件资源目录不存在: ${explicitResourceDir}`);
  }
  const resourceDir =
    (explicitResourceDir ? resolve(explicitResourceDir) : undefined) ||
    process.env.NIBI_BUNDLED_AGENT_RESOURCE_DIR?.trim() ||
    resolve(dirname(cliEntryPoint), "../../..");
  execFileSync(
    process.execPath,
    [cliEntryPoint, "plugins", "list", "--json"],
    {
      cwd: options.workspacePath,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: options.e2eHomeDir,
        NIBI_BUNDLED_AGENT_RESOURCE_DIR: resourceDir,
        NIBI_DATA_BASE_DIR: options.e2eHomeDir,
        USERPROFILE: options.e2eHomeDir,
      },
      stdio: "ignore",
      timeout: options.timeoutMs ?? 120_000,
      windowsHide: true,
    },
  );
}

/**
 * 预置来源/目标两条真实历史。必须在 Electron 完全退出后调用，避免运行中的 Host
 * 覆盖 tasks-index 或与 CLI DB 的迁移/写入竞争。
 */
export async function seedSixthBatchSessions(options: SixthBatchSeedOptions): Promise<void> {
  await ensureSixthBatchGitWorkspace(options.workspacePath);
  seedOfficialPluginsViaCli(options);
  const cliEntryPoint = resolveCliEntryPoint();
  const histories = [
    {
      sessionId: SIXTH_BATCH_SOURCE_SESSION_ID,
      title: SIXTH_BATCH_SOURCE_TITLE,
      userText: "Sixth batch source seed question.",
      assistantText: "Sixth batch source seed answer.",
    },
    {
      sessionId: SIXTH_BATCH_TARGET_SESSION_ID,
      title: SIXTH_BATCH_TARGET_TITLE,
      userText: "Sixth batch target seed question.",
      assistantText: "Sixth batch target seed answer.",
    },
  ];
  for (const history of histories) {
    await seedProviderReadinessHistoryFixture({
      cliEntryPoint,
      e2eHomeDir: options.e2eHomeDir,
      workspacePath: options.workspacePath,
      history: {
        ...history,
        assistantInputTokens: 0,
        assistantOutputTokens: 0,
        modelId: options.modelId,
        runtimeProviderId: options.providerId,
        taskProviderId: "glm",
      },
    });
  }
  const databasePath = join(options.e2eHomeDir, ".nibi", "cli", "db", "db.sqlite");
  for (const history of histories) {
    insertModelSelection(databasePath, history.sessionId, options);
  }
  await seedSixthBatchSourceRows(options);
}

/** U30 不可达来源：把来源会话从项目目录移除，但保留 CLI 会话与已投递的 row。 */
/**
 * 在目标会话里落两条带 `metadata.conversationInputIntent.source` 的真实历史。
 *
 * 走 Rust 冷加载路径（`kernel/crates/protocol-nibi/src/projection/rows.rs` 会把
 * source 原样投影到 userInput row），因此 UI「From session …」不是伪造 DOM。
 * 一条来源在 tasks-index 里可解析，另一条来源不可达。
 */
export async function seedSixthBatchSourceRows(options: SixthBatchSeedOptions): Promise<void> {
  const databasePath = join(options.e2eHomeDir, ".nibi", "cli", "db", "db.sqlite");
  const database = new DatabaseSync(databasePath);
  const rows = [
    {
      assistantText: "SIXTH_BATCH_TARGET_OK",
      marker: SIXTH_BATCH_SOURCE_REACHABLE_MARKER,
      sourceSessionId: SIXTH_BATCH_SOURCE_SESSION_ID,
      suffix: "reachable",
      turnId: "turn_sixth_batch_reachable",
    },
    {
      assistantText: "SIXTH_BATCH_TARGET_MISSING_OK",
      marker: SIXTH_BATCH_SOURCE_MISSING_MARKER,
      sourceSessionId: SIXTH_BATCH_MISSING_SESSION_ID,
      suffix: "missing",
      turnId: "turn_sixth_batch_missing",
    },
  ];
  const baseTime = Date.now() - 5_000;
  try {
    rows.forEach((row, index) => {
      const createdAt = baseTime + index * 1_000;
      const completedAt = createdAt + 500;
      const userText = `${row.marker}: review the cross-session note.`;
      const userId = `msg_user_sixth_source_${row.suffix}`;
      const assistantId = `msg_assistant_sixth_source_${row.suffix}`;
      const commandId = `cmd_sixth_source_${row.suffix}`;
      const intent = {
        admittedAt: createdAt,
        attachments: [],
        clientId: "cli",
        delivery: { admitted: "queue", requested: "queue" },
        dispatch: { state: "drained" },
        kind: "sendText",
        modelSelection: { modelId: options.modelId, providerId: options.providerId },
        order: { admissionSeq: 50 + index },
        queueItemId: commandId,
        source: { kind: "session", sessionId: row.sourceSessionId },
        sourceCommandId: commandId,
        steer: { state: "notRequested" },
        text: userText,
      };
      database
        .prepare(
          "insert or replace into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)",
        )
        .run(
          userId,
          SIXTH_BATCH_TARGET_SESSION_ID,
          createdAt,
          createdAt,
          JSON.stringify({
            agent: "nibi-agent",
            anchor: { turnId: row.turnId },
            content: userText,
            metadata: { conversationInputIntent: intent },
            modelSelection: { modelId: options.modelId, providerId: options.providerId },
            path: { cwd: options.workspacePath, root: options.workspacePath },
            role: "user",
            time: { created: createdAt },
          }),
        );
      database
        .prepare(
          "insert or replace into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
        )
        .run(
          `part_user_sixth_source_${row.suffix}`,
          userId,
          SIXTH_BATCH_TARGET_SESSION_ID,
          createdAt,
          createdAt,
          JSON.stringify({ text: userText, time: { end: createdAt, start: createdAt }, type: "text" }),
        );
      database
        .prepare(
          "insert or replace into message (id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?)",
        )
        .run(
          assistantId,
          SIXTH_BATCH_TARGET_SESSION_ID,
          createdAt + 200,
          completedAt,
          JSON.stringify({
            agent: "nibi-agent",
            anchor: { turnId: row.turnId },
            content: row.assistantText,
            cost: 0,
            finish: "stop",
            mode: "build",
            modelID: options.modelId,
            parentID: userId,
            path: { cwd: options.workspacePath, root: options.workspacePath },
            providerID: options.providerId,
            role: "assistant",
            time: { completed: completedAt, created: createdAt + 200 },
            tokens: {
              cache: { read: 0, write: 0 },
              input: 0,
              output: 0,
              reasoning: 0,
            },
          }),
        );
      database
        .prepare(
          "insert or replace into part (id, message_id, session_id, time_created, time_updated, data) values (?, ?, ?, ?, ?, ?)",
        )
        .run(
          `part_assistant_sixth_source_${row.suffix}`,
          assistantId,
          SIXTH_BATCH_TARGET_SESSION_ID,
          createdAt + 200,
          completedAt,
          JSON.stringify({
            text: row.assistantText,
            time: { end: completedAt, start: createdAt + 200 },
            type: "text",
          }),
        );
    });
  } finally {
    database.close();
  }
}

/** U30 诊断：读取目标会话最近一条 user message 的持久化 metadata（只读）。 */
export function readLatestUserMessageData(
  e2eHomeDir: string,
  sessionId: string,
): Array<Record<string, unknown>> {
  const databasePath = join(e2eHomeDir, ".nibi", "cli", "db", "db.sqlite");
  if (!existsSync(databasePath)) return [];
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database
      .prepare(
        "select id, data from message where session_id = ? order by time_created desc limit 5",
      )
      .all(sessionId) as Array<{ data: string; id: string }>;
    return rows.map((row) => {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(row.data) as Record<string, unknown>;
      } catch {
        parsed = { parseError: true };
      }
      return { id: row.id, ...parsed };
    });
  } finally {
    database.close();
  }
}

export function removeSixthBatchSourceFromDirectory(e2eHomeDir: string): void {
  const databasePath = join(e2eHomeDir, ".nibi", "v2", "tasks-index.sqlite");
  if (!existsSync(databasePath)) return;
  const database = new DatabaseSync(databasePath);
  try {
    database
      .prepare("delete from tasks where task_id = ?")
      .run(SIXTH_BATCH_SOURCE_SESSION_ID);
  } finally {
    database.close();
  }
}

export interface SixthBatchProcessInfo {
  pid: number;
  parentPid: number;
  name: string;
  commandLine: string;
}

function parseJsonProcessList(output: string): SixthBatchProcessInfo[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as
    | Array<Record<string, unknown>>
    | Record<string, unknown>;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .map((row) => ({
      pid: Number(row.ProcessId ?? 0),
      parentPid: Number(row.ParentProcessId ?? 0),
      name: String(row.Name ?? ""),
      commandLine: String(row.CommandLine ?? ""),
    }))
    .filter((row) => row.pid > 0);
}

/** Electron main 下的全部后代进程（Windows CIM；其他平台尽力用 ps）。 */
export function listDescendantProcesses(rootPid: number): SixthBatchProcessInfo[] {
  if (process.platform === "win32") {
    const script = String.raw`
$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine)
$byParent = @{}
foreach ($p in $all) {
  $key = [string]$p.ParentProcessId
  if (-not $byParent.ContainsKey($key)) { $byParent[$key] = New-Object System.Collections.ArrayList }
  [void]$byParent[$key].Add($p)
}
$result = New-Object System.Collections.ArrayList
$queue = New-Object System.Collections.Queue
$queue.Enqueue('__ROOT__')
while ($queue.Count -gt 0) {
  $current = [string]$queue.Dequeue()
  if ($byParent.ContainsKey($current)) {
    foreach ($child in $byParent[$current]) {
      [void]$result.Add($child)
      $queue.Enqueue([string]$child.ProcessId)
    }
  }
}
$result | ConvertTo-Json -Compress -Depth 4
`.replace("__ROOT__", String(rootPid));
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf-8", windowsHide: true, timeout: 30_000 },
    );
    return parseJsonProcessList(output);
  }
  const output = execFileSync("ps", ["-eo", "pid=,ppid=,comm=,args="], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  const children = new Map<number, SixthBatchProcessInfo[]>();
  for (const line of output.split(/\r?\n/u)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/u);
    if (!match) continue;
    const info = {
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      name: match[3] ?? "",
      commandLine: match[4] ?? "",
    };
    const siblings = children.get(info.parentPid) ?? [];
    siblings.push(info);
    children.set(info.parentPid, siblings);
  }
  const result: SixthBatchProcessInfo[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of children.get(current) ?? []) {
      result.push(child);
      queue.push(child.pid);
    }
  }
  return result;
}

function looksLikeAgentRuntime(processInfo: SixthBatchProcessInfo): boolean {
  if (/nibi-rs(?:\.exe)?$/iu.test(processInfo.name)) return true;
  return (
    processInfo.commandLine.includes("app-server") &&
    processInfo.commandLine.includes("--stdio")
  );
}

/** U22：结束 Electron main 进程树里的 Rust app-server，不碰 renderer/GPU/utility。 */
export function killAgentRuntimeProcesses(rootPid: number): SixthBatchProcessInfo[] {
  const targets = listDescendantProcesses(rootPid).filter(looksLikeAgentRuntime);
  if (targets.length === 0) return [];
  if (process.platform === "win32") {
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Stop-Process -Id ${targets.map((target) => target.pid).join(",")} -Force -ErrorAction SilentlyContinue`,
      ],
      { windowsHide: true, timeout: 30_000 },
    );
  } else {
    for (const target of targets) {
      try {
        process.kill(target.pid, "SIGKILL");
      } catch {
        // 进程可能已经被 Host 回收。
      }
    }
  }
  return targets;
}