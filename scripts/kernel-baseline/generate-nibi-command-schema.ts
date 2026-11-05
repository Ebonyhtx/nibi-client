/**
 * 从 NIBI 的单一来源 `packages/shared/src/nibi-protocol-v4/command.ts` 生成
 * `kernel/crates/protocol-nibi/schema/nibi-commands.json`。
 *
 * 用法：
 *   pnpm exec tsx scripts/kernel-baseline/generate-nibi-command-schema.ts
 *   pnpm exec tsx scripts/kernel-baseline/generate-nibi-command-schema.ts --check
 *
 * `--check` 只比较，不写文件；CI/本地门禁用它防止 Rust 侧命令表与 TS 漂移。
 * 生成物只含 payload schema 与 CAS 集合；信封字段（commandId/sessionId/...）由 Rust 侧
 * 的 `nibi_commands` 单独校验。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  COMMANDS_REQUIRING_BASE_REVISION,
  ROW_TARGETING_COMMANDS,
  commandPayloadSchemas,
} from "../../packages/shared/src/nibi-protocol-v4/command.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const output = resolve(
  repoRoot,
  "kernel/crates/protocol-nibi/schema/nibi-commands.json",
);

const names = Object.keys(commandPayloadSchemas);
if (names.length !== 34) {
  throw new Error(`NIBI commandPayloadSchemas must have 34 entries, got ${names.length}`);
}
if (COMMANDS_REQUIRING_BASE_REVISION.size !== 15) {
  throw new Error(
    `COMMANDS_REQUIRING_BASE_REVISION must have 15 entries, got ${COMMANDS_REQUIRING_BASE_REVISION.size}`,
  );
}
if (ROW_TARGETING_COMMANDS.size !== 5) {
  throw new Error(
    `ROW_TARGETING_COMMANDS must have 5 entries, got ${ROW_TARGETING_COMMANDS.size}`,
  );
}

const commands: Record<string, unknown> = {};
for (const name of names) {
  const schema = z.toJSONSchema(commandPayloadSchemas[name], {
    target: "draft-7",
    // Node 的 zod `.object()`（strip 语义）会剥掉未知键并放行；JSON Schema 表达不了
    // "剥掉但放行"，zod 4 生成器对 strip/strict 都写 additionalProperties:false。
    // 这里按 zod def 还原：catchall 缺省 = strip → 删掉 false，让 Rust 校验器与 Node
    // 同语义（未知键放行、由校验器自行决定）；`.strict()` 保留 false。
    override: (ctx) => {
      const jsonSchema = ctx.jsonSchema as Record<string, unknown>;
      if (jsonSchema.additionalProperties !== false) return;
      const def = (ctx.zodSchema as { _zod?: { def?: { catchall?: unknown } } })._zod?.def;
      if (!def?.catchall) delete jsonSchema.additionalProperties;
    },
  });
  // $schema 是整份文档级元数据；单个 payload 里不需要，Rust 的校验器也不认识。
  if (schema && typeof schema === "object" && "$schema" in schema) {
    delete (schema as Record<string, unknown>).$schema;
  }
  commands[name] = schema;
}

const document = {
  generatedFrom: "packages/shared/src/nibi-protocol-v4/command.ts",
  // 不写生成日期：`--check` 逐字节比较整份文件，带日期会让门禁在跨日后假红。
  // 真源与内容的对应关系由 commandTypes/CAS 集合与 payload schema 本身表达。
  commandTypes: names,
  requiresBaseRevision: [...COMMANDS_REQUIRING_BASE_REVISION].sort(),
  requiresBaseLogEpoch: [...ROW_TARGETING_COMMANDS].sort(),
  commands,
};
const text = `${JSON.stringify(document, null, 2)}\n`;

if (process.argv.includes("--check")) {
  let existing = "";
  try {
    existing = readFileSync(output, "utf8");
  } catch {
    throw new Error(`missing generated schema: ${output}`);
  }
  if (existing !== text) {
    throw new Error(
      `nibi-commands.json is stale; re-run without --check (${output})`,
    );
  }
  console.log("nibi-commands.json is up to date");
} else {
  writeFileSync(output, text, "utf8");
  console.log(`wrote ${output} (${names.length} commands)`);
}
