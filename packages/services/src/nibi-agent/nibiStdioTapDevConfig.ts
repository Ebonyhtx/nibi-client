import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NibiStdioTapDevState } from "@nibi/shared";
import { getAppConfigDir } from "#src/paths.js";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";

interface NibiStdioTapStateFile {
  enabled?: boolean;
}

export function isNibiStdioTapDevVisible(): boolean {
  return isEffectiveDevelopmentNodeEnv();
}

export function getNibiStdioTapDevDir(): string {
  return join(getAppConfigDir(), "dev");
}

export function getNibiStdioTapDevLogDir(): string {
  return join(getNibiStdioTapDevDir(), "stdio-traffic");
}

export function getNibiStdioTapDevStatePath(): string {
  return join(getNibiStdioTapDevDir(), "nibi-stdio-tap.json");
}

function readStateFile(path: string): NibiStdioTapStateFile {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as NibiStdioTapStateFile) : {};
  } catch {
    return {};
  }
}

export function readNibiStdioTapDevState(): NibiStdioTapDevState {
  const visible = isNibiStdioTapDevVisible();
  const statePath = getNibiStdioTapDevStatePath();
  const fileState = readStateFile(statePath);
  return {
    enabled: visible && fileState.enabled === true,
    visible,
    logDir: getNibiStdioTapDevLogDir(),
    statePath,
  };
}

export function setNibiStdioTapDevEnabled(enabled: boolean): NibiStdioTapDevState {
  const visible = isNibiStdioTapDevVisible();
  const statePath = getNibiStdioTapDevStatePath();
  mkdirSync(getNibiStdioTapDevDir(), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        // 开发态 stdio 抓包是高频原始协议帧，只能通过显式开关写旁路文件，避免误进生产日志。
        enabled: visible && enabled,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return readNibiStdioTapDevState();
}
