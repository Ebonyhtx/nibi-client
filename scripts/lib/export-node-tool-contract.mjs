#!/usr/bin/env node
/**
 * X02：从 Node 源码确定性导出内置工具契约（input schema + 结果预算）。
 *
 * 由 `scripts/check-dual-kernel-parity.mjs --update/--check --live` 以
 *   node --import tsx scripts/lib/export-node-tool-contract.mjs
 * 调用；只读本地源码与 workspace 依赖，不联网、不调用真实模型。
 *
 * 显式从 `src` 而不是 `dist` 导入：--update 生成的 fixture 要反映当前检出源码，
 * 不能让过期构建产物把契约漂移藏起来。Node 侧的 freshness 由
 * `apps/nibi-cli/packages/core/tests/tool-parity.test.ts` 再独立断言一次；该测试
 * 直接 import 本文件的 `exportNodeToolEntries`，与 `--update` 走同一条投影。
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { builtInTools } from "../../apps/nibi-cli/packages/core/src/tool/handlers/index.ts";

/**
 * 动态模型契约的固定投影上下文。
 *
 * `Read` 的 `pages` 只在模型支持 PDF 时由 `resolveModelContract` 注入（上游 fec97590
 * 同构；静态 `inputSchema` 是 PDF 不支持时的基线）。X02 快照记录工具**可暴露的完整面**，
 * 所以固定按「支持 PDF + 图片」投影；这与 Rust 内核恒含 `pages` 的 schema 对齐，
 * 也避免把「模型能力不同」误报成「Node 缺字段」。
 */
export const NODE_MODEL_CONTRACT_CONTEXT = {
  model: { properties: { inputFormat: { supportsPdf: true, supportsImage: true } } },
};

export function exportNodeToolEntry(entry) {
  const projection = entry.resolveModelContract?.(NODE_MODEL_CONTRACT_CONTEXT);
  return {
    name: entry.metadata.name,
    inputSchema: projection?.inputSchema ?? entry.inputSchema,
    resultBudget: entry.resultBudget ?? null,
    maxModelChars: entry.maxModelChars ?? null,
  };
}

export function exportNodeToolEntries(entries = builtInTools) {
  return entries
    .map(exportNodeToolEntry)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function main() {
  const entries = exportNodeToolEntries();
  process.stdout.write(
    `${JSON.stringify(
      {
        version: 1,
        side: "node",
        source: "apps/nibi-cli/packages/core/src/tool/handlers/index.ts builtInTools",
        tools: entries,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
