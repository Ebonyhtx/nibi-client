/**
 * 存储准备握手探针（驱动器的 storagePrepare 阶段；Host 的启动存储门）。
 *
 * 四个用例各自起独立子进程（同一次准备一个进程），两边内核用同一份 db 路径（SESSION_DB_PATH
 * env 指过去），帧序列、迁移事实、databaseId 与退出码逐字段对拍：
 *   initialize：全新库 → checking×3 → migrating×24 → committing → ready → storagePrepared；
 *   none：同一库重跑 → checking、checking(事实)、committing、ready；
 *   reuse：确认帧带 reuse:true → 完全没有 state 帧；
 *   corrupt：预写垃圾文件 → failed(corrupt, sqliteCode 26)×2 份（Node 两层 catch 同形）→ 退出码 1。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export async function runStoragePreparePhase({ bin, binArgs, isNode, home, dotDir, checks }) {
  const { createHash } = await import("node:crypto");
  const { createInterface } = await import("node:readline");

  const prepareHome = (name) => {
    const root = join(home, `prepare-${name}`);
    mkdirSync(root, { recursive: true });
    return root;
  };
  const envFor = (caseHome, dbPath) => ({
    ...process.env,
    USERPROFILE: caseHome,
    HOME: caseHome,
    ...(isNode
      ? {
          NIBI_DATA_BASE_DIR: caseHome,
          NIBI_SETTINGS_DIR: join(caseHome, dotDir, "v2"),
          NIBI_SESSION_DB_PATH: dbPath,
        }
      : {
          ZCODE_DATA_BASE_DIR: caseHome,
          ZCODE_SESSION_DB_PATH: dbPath,
        }),
  });
  const expectedDatabaseId = (dbPath) =>
    createHash("sha256").update(resolve(dbPath)).digest("hex");

  // Host 角色跑一遍握手；返回帧与退出码。
  const runPrepare = (caseHome, dbPath, { reuse = false, prewrite = null } = {}) =>
    new Promise((resolveRun, rejectRun) => {
      if (prewrite !== null) writeFileSync(dbPath, prewrite);
      const child = spawn(bin, [...binArgs, "--prepare-storage"], {
        cwd: caseHome,
        env: envFor(caseHome, dbPath),
        stdio: ["pipe", "pipe", "pipe"],
      });
      const startedAt = Date.now();
      const lines = createInterface({ input: child.stdout });
      const stateFrames = [];
      let storagePath = null;
      let prepared = false;
      let firstFrameAt = null;
      let failure = null;
      const finish = () => ({ stateFrames, storagePath, prepared, firstFrameAt, startedAt });
      const timer = setTimeout(() => {
        failure = new Error("storage prepare handshake timed out");
        child.kill();
      }, 30_000);
      child.stderr.resume();
      lines.on("line", (line) => {
        if (line.length > 65536) return;
        let frame;
        try {
          frame = JSON.parse(line);
        } catch {
          return;
        }
        if (frame?.method === "startup/storagePath") {
          storagePath = frame.params?.path ?? null;
          child.stdin.write(
            `${JSON.stringify({ method: "startup/storagePathReady", reuse })}\n`,
          );
        } else if (frame?.method === "startup/storageState") {
          if (stateFrames.length === 0) firstFrameAt = Date.now() - startedAt;
          stateFrames.push(frame.params ?? {});
        } else if (frame?.method === "startup/storagePrepared") {
          prepared = true;
          child.stdin.end();
        }
      });
      child.on("error", (error) => {
        failure ??= error;
      });
      // 在 stdout 完全排干后 resolve（close 事件会跟最后几行 line 竞争）。
      let exitCode = null;
      let drained = false;
      let settledRun = false;
      const settle = () => {
        if (settledRun || failure || exitCode === null || !drained) return;
        settledRun = true;
        clearTimeout(timer);
        resolveRun({ ...finish(), exit: exitCode });
      };
      child.on("exit", (code) => {
        exitCode = code;
        settle();
      });
      child.stdout.on("end", () => {
        drained = true;
        settle();
      });
    });

  // 连续同名 phase 压缩成 migrating×N（两边的 elapsedMs 不同，phase 序列必须相同）。
  const phaseSequence = (frames) => {
    const sequence = [];
    for (const frame of frames) {
      const last = sequence[sequence.length - 1];
      if (last?.phase === frame.phase && last.phase === "migrating") {
        last.count += 1;
      } else if (last?.phase === frame.phase) {
        last.count += 1;
      } else {
        sequence.push({ phase: frame.phase, count: 1 });
      }
    }
    return sequence.map(({ phase, count }) => (count > 1 ? `${phase}x${count}` : phase)).join(",");
  };
  const lastFacts = (frames) => {
    const withFacts = [...frames].reverse().find((frame) => frame.migration);
    return withFacts
      ? JSON.stringify({
          kind: withFacts.migration.kind,
          executedCount: withFacts.migration.executedCount,
          committedCount: withFacts.migration.committedCount,
          lastAppliedMigrationId: withFacts.migration.lastAppliedMigrationId ?? null,
        })
      : null;
  };
  const migratingIds = (frames) =>
    frames
      .filter((frame) => frame.phase === "migrating")
      .map((frame) => frame.migrationId)
      .join(",");

  // 用例 1：全新库（initialize）。
  const initHome = prepareHome("init");
  const initDb = join(initHome, "db.sqlite");
  const init = await runPrepare(initHome, initDb);
  checks.storagePrepareInitExit = init.exit;
  checks.storagePrepareInitPhases = phaseSequence(init.stateFrames);
  checks.storagePrepareInitFacts = lastFacts(init.stateFrames);
  checks.storagePrepareInitMigrationIds = migratingIds(init.stateFrames);
  checks.storagePrepareInitFirstFrameMs = init.firstFrameAt !== null;
  checks.storagePrepareInitPrepared = init.prepared;
  checks.storagePrepareInitPathAbsolute =
    typeof init.storagePath === "string" && init.storagePath.length > 0;
  // databaseId 是各自库路径的 sha256（两次 driver 运行的临时根不同，原值不可比）；
  // 可比的是「等于自己路径的 sha256」这一事实——散列函数与 Node 逐字节一致由
  // node-store 的 the_database_id_matches_node 用例钉死。
  const databaseId = init.stateFrames[0]?.databaseId ?? null;
  checks.storagePrepareDatabaseIdMatches =
    typeof databaseId === "string" &&
    init.storagePath !== null &&
    resolve(init.storagePath) === resolve(initDb) &&
    databaseId === expectedDatabaseId(initDb);
  checks.storagePrepareInitTotal =
    init.stateFrames.find((frame) => frame.phase === "migrating")?.total ?? null;

  // 用例 2：同一库重跑（none）。
  const rerun = await runPrepare(initHome, initDb);
  checks.storagePrepareNoneExit = rerun.exit;
  checks.storagePrepareNonePhases = phaseSequence(rerun.stateFrames);
  checks.storagePrepareNoneFacts = lastFacts(rerun.stateFrames);
  checks.storagePrepareNonePrepared = rerun.prepared;

  // 用例 3：reuse:true（Host 这次准备里已经备好的库不再打开）。
  const reuse = await runPrepare(initHome, initDb, { reuse: true });
  checks.storagePrepareReuseExit = reuse.exit;
  checks.storagePrepareReuseStateFrames = reuse.stateFrames.length;
  checks.storagePrepareReusePrepared = reuse.prepared;

  // 用例 4：损坏库（corrupt，退出码 1，两层 failed 帧）。
  const corruptHome = prepareHome("corrupt");
  const corruptDb = join(corruptHome, "db.sqlite");
  const corrupt = await runPrepare(corruptHome, corruptDb, {
    prewrite: "this file is not a sqlite database",
  });
  checks.storagePrepareCorruptExit = corrupt.exit;
  const corruptFailed = corrupt.stateFrames.filter((frame) => frame.phase === "failed");
  checks.storagePrepareCorruptCode = corruptFailed[0]?.errorCode ?? null;
  checks.storagePrepareCorruptSqlite = String(corruptFailed[0]?.sqliteCode ?? "none");
  checks.storagePrepareCorruptFreshAttempt =
    corruptFailed.length === 2 &&
    corruptFailed[1]?.attemptId !== corruptFailed[0]?.attemptId &&
    corruptFailed[1]?.sequence === 1 &&
    corruptFailed[1]?.errorCode === "corrupt";
  checks.storagePrepareCorruptPrepared = corrupt.prepared;

  console.log(
    `storage prepare: init=${checks.storagePrepareInitExit} phases=${checks.storagePrepareInitPhases} ` +
      `none=${checks.storagePrepareNoneExit} reuse=${checks.storagePrepareReuseExit}/${checks.storagePrepareReuseStateFrames}frames ` +
      `corrupt=${checks.storagePrepareCorruptExit}/${checks.storagePrepareCorruptCode} dbId=${checks.storagePrepareDatabaseIdMatches}`,
  );
  if (!checks.storagePrepareInitPrepared || checks.storagePrepareInitExit !== 0) {
    throw new Error("storage prepare initialize case failed");
  }
  if (!checks.storagePrepareDatabaseIdMatches) {
    throw new Error("databaseId is not the sha256 of the resolved db path");
  }
  if (checks.storagePrepareReuseStateFrames !== 0) {
    throw new Error("reuse:true still produced storage state frames");
  }
  if (checks.storagePrepareCorruptExit !== 1 || checks.storagePrepareCorruptCode !== "corrupt") {
    throw new Error("corrupt case did not fail with corrupt");
  }

}
