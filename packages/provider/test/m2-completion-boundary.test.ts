import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const productionRoots = [
  "packages/provider/src",
  "packages/provider-node/src",
  "packages/services/src",
  "packages/ui/src",
  "packages/desktop/src",
  "packages/shared/src",
  "apps/zcode-cli/packages/adapters/src",
  "apps/zcode-cli/packages/bootstrap/src",
  "apps/zcode-cli/packages/cli/src",
  "apps/zcode-cli/packages/contracts/src",
  "apps/zcode-cli/packages/core/src",
  "apps/zcode-cli/packages/tui/src",
] as const;

const testRoots = [
  "packages/desktop/test",
  "packages/services/test",
  "packages/shared/test",
  "packages/ui/test",
] as const;

describe("M2 completion boundary", () => {
  // 4.0 分家后没有需要迁移的历史数据，整套「旧 config.json → 新 provider 配置」的导入边界
  // 已连同 reader / importer / DTO 三个文件与两处注入点一起删除。
  // 判据从「只允许出现在迁移边界」收紧为「一处都不许出现」。
  it("旧 ZCode Provider DTO 已彻底移除", async () => {
    expect(await findProductionFilesMatching(/\bModelProviderConfig\b/u)).toEqual([]);
    expect(await findFilesMatching(testRoots, /\bModelProviderConfig\b/u)).toEqual([]);
  });

  it("生产实现不再读取旧 Provider Store 路径", async () => {
    expect(await findProductionFilesContaining("model-providers.json")).toEqual([]);
  });

  it("正式 Provider 消费链路不再使用旧 API format 类型", async () => {
    expect(await findProductionFilesMatching(/\bModelProviderApiFormat\b/u)).toEqual([]);
  });
});

async function findProductionFilesContaining(needle: string): Promise<string[]> {
  return findProductionFilesMatching(new RegExp(escapeRegExp(needle), "u"));
}

async function findProductionFilesMatching(pattern: RegExp): Promise<string[]> {
  return findFilesMatching(productionRoots, pattern);
}

async function findFilesMatching(roots: readonly string[], pattern: RegExp): Promise<string[]> {
  const files = (
    await Promise.all(roots.map((root) => collectSourceFiles(resolve(repositoryRoot, root))))
  ).flat();
  const matches: string[] = [];
  for (const file of files) {
    if (pattern.test(await readFile(file, "utf-8"))) {
      // 路径作为跨平台模块标识，统一 POSIX 分隔符比较（Windows readdir 产出 \）。
      matches.push(relative(repositoryRoot, file).replaceAll("\\", "/"));
    }
  }
  return matches.sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function collectSourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(path);
      return extname(entry.name) === ".ts" || extname(entry.name) === ".tsx" ? [path] : [];
    }),
  );
  return files.flat();
}
