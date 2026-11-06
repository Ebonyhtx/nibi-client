import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startElectronWindowRecording } from "./e2e/helpers/electron-window-recorder.js";
import { runElectronRecordingCommand } from "./e2e/helpers/electron-window-recorder-timeout.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("Electron window recorder", () => {
  it("records renderer frames through Electron capturePage metadata", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zcode-electron-recorder-"));
    tempDirs.push(tempDir);
    const outputPath = join(tempDir, "electron-repro.webm");
    const encodedFrameCounts: number[] = [];

    const session = await startElectronWindowRecording({
      captureFrame: async () => Buffer.from("fake-png-frame"),
      encodeVideo: async ({ framePaths, outputPath: encodedOutputPath }) => {
        encodedFrameCounts.push(framePaths.length);
        await readFile(framePaths[0]);
        await writeFile(encodedOutputPath, "fake-webm");
      },
      frameIntervalMs: 60_000,
      outputPath,
    });

    const result = await session.stop();

    expect(result.captureMode).toBe("electron_capture_page");
    expect(result.videoPath).toBe(outputPath);
    expect(result.frameCount).toBeGreaterThanOrEqual(2);
    expect(encodedFrameCounts).toEqual([result.frameCount]);
    await expect(readFile(outputPath, "utf8")).resolves.toBe("fake-webm");
  });

  it("discards passing-case frames without invoking the encoder", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zcode-electron-recorder-"));
    tempDirs.push(tempDir);
    const outputPath = join(tempDir, "electron-repro.webm");
    const frameDir = join(tempDir, "frames");
    const encodeVideo = vi.fn();

    const session = await startElectronWindowRecording({
      captureFrame: async () => Buffer.from("fake-png-frame"),
      encodeVideo,
      frameDir,
      frameIntervalMs: 60_000,
      outputPath,
    });

    await session.discard();

    expect(encodeVideo).not.toHaveBeenCalled();
    await expect(access(frameDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(outputPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("collects a pre-roll before allowing the case to start", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zcode-electron-recorder-"));
    tempDirs.push(tempDir);
    const startedAt = Date.now();
    const session = await startElectronWindowRecording({
      captureFrame: async () => Buffer.from("fake-png-frame"),
      frameIntervalMs: 100,
      outputPath: join(tempDir, "electron-repro.webm"),
      preRollDurationMs: 120,
    });

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    await session.discard();
  });

  it("keeps the video timeline aligned with the case when later captures are missed", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zcode-electron-recorder-"));
    tempDirs.push(tempDir);
    const outputPath = join(tempDir, "electron-repro.webm");
    const encodedFrameCounts: number[] = [];
    let captureAttempts = 0;

    const session = await startElectronWindowRecording({
      captureFrame: async () => {
        captureAttempts += 1;
        if (captureAttempts === 1) {
          return Buffer.from("first-frame");
        }
        throw new Error("capturePage became unavailable");
      },
      encodeVideo: async ({ framePaths, outputPath: encodedOutputPath }) => {
        encodedFrameCounts.push(framePaths.length);
        await writeFile(encodedOutputPath, "fake-webm");
      },
      frameIntervalMs: 100,
      outputPath,
    });

    await new Promise((resolveWait) => setTimeout(resolveWait, 240));
    const result = await session.stop();

    expect(result.frameCount).toBeGreaterThanOrEqual(3);
    expect(encodedFrameCounts).toEqual([result.frameCount]);
    expect(result.captureError).toContain("capturePage became unavailable");
  });

  it("bounds a capturePage request that never settles", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zcode-electron-recorder-"));
    tempDirs.push(tempDir);
    const startedAt = Date.now();

    await expect(
      startElectronWindowRecording({
        captureFrame: () => new Promise<Buffer>(() => undefined),
        captureTimeoutMs: 30,
        outputPath: join(tempDir, "electron-repro.webm"),
      }),
    ).rejects.toThrow("frame capture timed out after 30ms");

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("bounds a custom encoder that never settles", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zcode-electron-recorder-"));
    tempDirs.push(tempDir);
    const startedAt = Date.now();
    const session = await startElectronWindowRecording({
      captureFrame: async () => Buffer.from("fake-png-frame"),
      encodeTimeoutMs: 30,
      encodeVideo: () => new Promise<void>(() => undefined),
      frameIntervalMs: 60_000,
      outputPath: join(tempDir, "electron-repro.webm"),
      // 这条用例判的是**编码预算**。整个 stop 路径外面还有一层总预算
      // （`runWithTimeout(..., stopTimeoutMs, "Electron window recording stop")`），
      // 以前这里给 100ms：慢机器上任意一次调度抖动超过 70ms，先响的就是外层预算，
      // 报错变成 "recording stop timed out"，用例偶发失败——失败的是机器，不是行为。
      // 外层预算自己的行为由下一条用例专门判，所以这里把它抬到不会再抢先的值。
      stopTimeoutMs: 5 * 60_000,
    });

    await expect(session.stop()).rejects.toThrow("video encoding timed out after 30ms");
    // 顺带证明响的是 30ms 那条，而不是外层预算"最终也会超时"。
    expect(Date.now() - startedAt).toBeLessThan(30_000);
  });

  it("bounds the complete stop path even while tail recording", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zcode-electron-recorder-"));
    tempDirs.push(tempDir);
    const session = await startElectronWindowRecording({
      captureFrame: async () => Buffer.from("fake-png-frame"),
      frameIntervalMs: 60_000,
      outputPath: join(tempDir, "electron-repro.webm"),
      stopTimeoutMs: 30,
    });

    await expect(session.stop({ tailDurationMs: 1_000 })).rejects.toThrow(
      "recording stop timed out after 30ms",
    );
  });

  it("kills a recording command that exceeds its timeout", async () => {
    await expect(
      runElectronRecordingCommand(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
        timeoutMs: 100,
      }),
    ).rejects.toThrow("timed out after 100ms");
  });
});
