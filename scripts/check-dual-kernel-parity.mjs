#!/usr/bin/env node
/**
 * X02 双内核工具/权限对拍门禁（结构化部分）。
 *
 * 判据：canonical 清单 `packages/shared/src/kernel-contract/tool-parity.json` 必须
 *   1. 结构完整：版本、计数、side、只读/审批字段、权限名、错误码；
 *   2. 计数与数组一致（删条目却不更新 counts 会红）；
 *   3. 每个单侧工具/错误码都在 `capabilities.json` 有同 side 的例外登记；
 *   4. 反向也成立：capabilities 里 `tool.*` / `errorCode.*` / `permission.*` 的例外
 *      必须被 canonical 引用（陈旧例外会红）。
 *
 * 不在这里做的一件事：把清单和两侧**活注册表**逐项比较。那由
 * `apps/nibi-cli/packages/core/tests/tool-parity.test.ts`（Node builtInTools）与
 * `kernel/crates/tools/src/parity_tests.rs`（nibi-kernel-tools 注册表）执行；本脚本只读
 * JSON，所以能放进无需 pnpm install 的 policy job。
 *
 * 用法：
 *   node scripts/check-dual-kernel-parity.mjs [--json] [canonicalPath] [capabilitiesPath]
 * 退出码：0 = 通过；1 = 有命中。
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CANONICAL = join(
  HERE,
  "..",
  "packages",
  "shared",
  "src",
  "kernel-contract",
  "tool-parity.json",
);
const DEFAULT_CAPABILITIES = join(
  HERE,
  "..",
  "packages",
  "shared",
  "src",
  "kernel-contract",
  "capabilities.json",
);

export const ALLOWED_SIDES = new Set(["both", "rust", "node"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isBoolean(value) {
  return typeof value === "boolean";
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

export function toolParityCounts(document, capabilities) {
  const tools = Array.isArray(document?.tools) ? document.tools : [];
  const excluded = Array.isArray(document?.scope?.excluded) ? document.scope.excluded : [];
  const permissions = Array.isArray(document?.permissions?.names)
    ? document.permissions.names
    : [];
  const errorCodes = Array.isArray(document?.errorCodes) ? document.errorCodes : [];
  const exceptions = Array.isArray(capabilities?.singleSideExceptions)
    ? capabilities.singleSideExceptions
    : [];
  return {
    tools: tools.length,
    bothTools: tools.filter((tool) => tool?.side === "both").length,
    nodeOnlyTools: tools.filter((tool) => tool?.side === "node").length,
    rustOnlyTools: tools.filter((tool) => tool?.side === "rust").length,
    nodeTools: tools.filter((tool) => tool?.side !== "rust").length,
    rustTools: tools.filter((tool) => tool?.side !== "node").length,
    permissions: permissions.length,
    errorCodes: errorCodes.length,
    bothErrorCodes: errorCodes.filter((code) => code?.side === "both").length,
    nodeOnlyErrorCodes: errorCodes.filter((code) => code?.side === "node").length,
    rustOnlyErrorCodes: errorCodes.filter((code) => code?.side === "rust").length,
    excluded: excluded.length,
    exceptions: exceptions.length,
  };
}

/**
 * 纯校验函数：门禁与单测共用，避免“门禁自己就是唯一实现”。
 * 返回错误消息数组；空数组表示通过。
 */
export function validateToolParity(document, capabilities) {
  const errors = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return ["tool-parity 必须是 JSON 对象"];
  }
  if (document.version !== 1) {
    errors.push(`version 必须是 1（当前 ${JSON.stringify(document.version)}）`);
  }

  const scope = document.scope;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    errors.push("scope 必须是对象");
  } else {
    if (!isNonEmptyString(scope.node)) errors.push("scope.node 必须是非空字符串");
    if (!isNonEmptyString(scope.rust)) errors.push("scope.rust 必须是非空字符串");
    if (!Array.isArray(scope.excluded)) {
      errors.push("scope.excluded 必须是数组（没有排除项也要显式写空数组）");
    }
  }

  if (!Array.isArray(document.tools) || document.tools.length === 0) {
    errors.push("tools 必须是非空数组");
  }

  const toolNames = new Set();
  const excludedNames = new Set();
  for (const [index, tool] of (Array.isArray(document.tools) ? document.tools : []).entries()) {
    const where = `tools[${index}]`;
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
      errors.push(`${where} 必须是对象`);
      continue;
    }
    if (!isNonEmptyString(tool.name)) {
      errors.push(`${where}.name 必须是非空字符串`);
      continue;
    }
    if (toolNames.has(tool.name)) errors.push(`${where}.name ${tool.name} 重复`);
    toolNames.add(tool.name);
    if (!ALLOWED_SIDES.has(tool.side)) {
      errors.push(`${where}.side 必须是 both / node / rust（当前 ${JSON.stringify(tool.side)}）`);
      continue;
    }
    const hasNode = tool.side !== "rust";
    const hasRust = tool.side !== "node";

    if (tool.readOnly !== undefined && !isBoolean(tool.readOnly)) {
      errors.push(`${where}.readOnly 必须是布尔值`);
    }
    if (tool.nodeReadOnly !== undefined && !isBoolean(tool.nodeReadOnly)) {
      errors.push(`${where}.nodeReadOnly 必须是布尔值`);
    }
    if (tool.rustReadOnly !== undefined && !isBoolean(tool.rustReadOnly)) {
      errors.push(`${where}.rustReadOnly 必须是布尔值`);
    }
    if (
      tool.readOnly !== undefined &&
      (tool.nodeReadOnly !== undefined || tool.rustReadOnly !== undefined)
    ) {
      errors.push(`${where} 不要同时写 readOnly 与 nodeReadOnly/rustReadOnly`);
    }
    if (
      isBoolean(tool.nodeReadOnly) &&
      isBoolean(tool.rustReadOnly) &&
      tool.nodeReadOnly !== tool.rustReadOnly &&
      !isNonEmptyString(tool.note)
    ) {
      errors.push(`${where} 两侧 readOnly 不同但不一致时必须写 note 说明`);
    }
    if (tool.note !== undefined && !isNonEmptyString(tool.note)) {
      errors.push(`${where}.note 必须是非空字符串`);
    }

    if (hasNode) {
      if (!isNonEmptyString(tool.permission)) {
        errors.push(`${where}.permission 必须是非空字符串（Node 工具权限分类）`);
      }
      if (!isBoolean(tool.needsApproval)) {
        errors.push(`${where}.needsApproval 必须是布尔值`);
      }
      if (tool.alwaysAsk !== undefined && !isBoolean(tool.alwaysAsk)) {
        errors.push(`${where}.alwaysAsk 必须是布尔值`);
      }
    } else {
      if (tool.permission !== undefined) errors.push(`${where} 是 rust 单侧，不应写 permission`);
      if (tool.needsApproval !== undefined) {
        errors.push(`${where} 是 rust 单侧，不应写 needsApproval`);
      }
      if (tool.alwaysAsk !== undefined) errors.push(`${where} 是 rust 单侧，不应写 alwaysAsk`);
      if (tool.nodeReadOnly !== undefined) {
        errors.push(`${where} 是 rust 单侧，不应写 nodeReadOnly`);
      }
    }

    if (hasRust) {
      if (!isBoolean(tool.rustAsks)) {
        errors.push(`${where}.rustAsks 必须是布尔值（Rust check_permissions 探针）`);
      }
    } else if (tool.rustAsks !== undefined) {
      errors.push(`${where} 是 node 单侧，不应写 rustAsks`);
    }

    const nodeReadOnly = tool.nodeReadOnly ?? tool.readOnly;
    const rustReadOnly = tool.rustReadOnly ?? tool.readOnly;
    if (hasNode && !isBoolean(nodeReadOnly)) {
      errors.push(`${where} 缺少 Node 只读值（readOnly 或 nodeReadOnly）`);
    }
    if (hasRust && !isBoolean(rustReadOnly)) {
      errors.push(`${where} 缺少 Rust 只读值（readOnly 或 rustReadOnly）`);
    }
  }

  for (const [index, entry] of (Array.isArray(scope?.excluded) ? scope.excluded : []).entries()) {
    const where = `scope.excluded[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${where} 必须是对象`);
      continue;
    }
    if (!isNonEmptyString(entry.name)) {
      errors.push(`${where}.name 必须是非空字符串`);
      continue;
    }
    if (excludedNames.has(entry.name)) errors.push(`${where}.name ${entry.name} 重复`);
    excludedNames.add(entry.name);
    if (!["node", "rust"].includes(entry.side)) {
      errors.push(`${where}.side 必须是 node / rust（当前 ${JSON.stringify(entry.side)}）`);
    }
    if (!isNonEmptyString(entry.reason)) {
      errors.push(`${where}.reason 必须是非空字符串`);
    }
    if (toolNames.has(entry.name)) {
      errors.push(`${where}.name ${entry.name} 同时出现在 tools 与 excluded`);
    }
  }

  const permissions = document.permissions;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    errors.push("permissions 必须是对象");
  } else {
    if (permissions.side !== "node") {
      errors.push(`permissions.side 必须是 node（当前 ${JSON.stringify(permissions.side)}）`);
    }
    if (!isNonEmptyString(permissions.source)) {
      errors.push("permissions.source 必须是非空字符串");
    }
    if (!Array.isArray(permissions.names) || permissions.names.length === 0) {
      errors.push("permissions.names 必须是非空数组");
    } else {
      const seen = new Set();
      for (const [index, name] of permissions.names.entries()) {
        if (!isNonEmptyString(name)) {
          errors.push(`permissions.names[${index}] 必须是非空字符串`);
          continue;
        }
        if (seen.has(name)) errors.push(`permissions.names ${name} 重复`);
        seen.add(name);
      }
    }
  }

  const errorCodes = Array.isArray(document.errorCodes) ? document.errorCodes : [];
  if (errorCodes.length === 0) {
    errors.push("errorCodes 必须是非空数组");
  }
  const errorNames = new Set();
  for (const [index, code] of errorCodes.entries()) {
    const where = `errorCodes[${index}]`;
    if (!code || typeof code !== "object" || Array.isArray(code)) {
      errors.push(`${where} 必须是对象`);
      continue;
    }
    if (!isNonEmptyString(code.name)) {
      errors.push(`${where}.name 必须是非空字符串`);
      continue;
    }
    if (errorNames.has(code.name)) errors.push(`${where}.name ${code.name} 重复`);
    errorNames.add(code.name);
    if (!ALLOWED_SIDES.has(code.side)) {
      errors.push(`${where}.side 必须是 both / node / rust（当前 ${JSON.stringify(code.side)}）`);
      continue;
    }
    const hasNode = code.side !== "rust";
    const hasRust = code.side !== "node";
    if (hasNode && !isNonEmptyString(code.node)) {
      errors.push(`${where}.node 必须是非空字符串`);
    }
    if (hasRust && !isNonEmptyString(code.rust)) {
      errors.push(`${where}.rust 必须是非空字符串`);
    }
    if (!hasNode && code.node !== undefined) {
      errors.push(`${where} 是 rust 单侧，不应写 node`);
    }
    if (!hasRust && code.rust !== undefined) {
      errors.push(`${where} 是 node 单侧，不应写 rust`);
    }
  }

  const counts = document.counts;
  if (!counts || typeof counts !== "object" || Array.isArray(counts)) {
    errors.push("counts 必须是对象");
  } else {
    const computed = toolParityCounts(document, capabilities);
    for (const key of [
      "tools",
      "nodeTools",
      "rustTools",
      "permissions",
      "errorCodes",
    ]) {
      if (!isNonNegativeInteger(counts[key])) {
        errors.push(`counts.${key} 必须是非负整数`);
      } else if (counts[key] !== computed[key]) {
        errors.push(`counts.${key} ${counts[key]} != 实际 ${computed[key]}（删/加条目要同步计数）`);
      }
    }
  }

  const exceptionEntries = Array.isArray(capabilities?.singleSideExceptions)
    ? capabilities.singleSideExceptions
    : null;
  if (!exceptionEntries) {
    errors.push("capabilities.singleSideExceptions 必须存在（单侧例外登记表）");
    return errors;
  }
  const exceptions = new Map();
  for (const entry of exceptionEntries) {
    if (!entry || typeof entry !== "object" || !isNonEmptyString(entry.capability)) continue;
    if (exceptions.has(entry.capability)) {
      errors.push(`capabilities.singleSideExceptions ${entry.capability} 重复登记`);
    }
    exceptions.set(entry.capability, entry);
  }

  const usedExceptions = new Set();
  const requireException = (capability, side, label) => {
    const entry = exceptions.get(capability);
    if (!entry) {
      errors.push(`${label} 缺 capabilities 登记 ${capability}（side=${side}）`);
      return;
    }
    if (entry.side !== side) {
      errors.push(`${capability} 的 capabilities side 是 ${JSON.stringify(entry.side)}，应为 ${side}`);
    }
    usedExceptions.add(capability);
  };

  for (const tool of Array.isArray(document.tools) ? document.tools : []) {
    if (!tool || !isNonEmptyString(tool.name) || !["node", "rust"].includes(tool.side)) continue;
    requireException(`tool.${tool.name}`, tool.side, `工具 ${tool.name}`);
  }

  for (const code of errorCodes) {
    if (!code || !isNonEmptyString(code.name) || !["node", "rust"].includes(code.side)) continue;
    const exact = `errorCode.${code.name}`;
    if (exceptions.has(exact)) {
      requireException(exact, code.side, `错误码 ${code.name}`);
      continue;
    }
    const wildcard = `errorCode.${code.side}Only.*`;
    const entry = exceptions.get(wildcard);
    if (!entry) {
      errors.push(`错误码 ${code.name} 缺 capabilities 登记（${exact} 或 ${wildcard}）`);
      continue;
    }
    if (entry.side !== code.side) {
      errors.push(`${wildcard} 的 capabilities side 是 ${JSON.stringify(entry.side)}，应为 ${code.side}`);
    }
    usedExceptions.add(wildcard);
  }

  if (Array.isArray(permissions?.names) && permissions.names.length > 0) {
    requireException("permission.nodeCategories", "node", "权限分类表");
  }

  for (const capability of exceptions.keys()) {
    if (!/^(tool|errorCode|permission)\./.test(capability)) continue;
    if (!usedExceptions.has(capability)) {
      errors.push(`capabilities 例外 ${capability} 未被 canonical 引用（陈旧登记）`);
    }
  }

  return errors;
}

function parseArgs(argv) {
  const flags = new Set();
  const paths = [];
  for (const argument of argv) {
    if (argument === "--json") flags.add(argument);
    else if (argument === "--help" || argument === "-h") flags.add(argument);
    else paths.push(argument);
  }
  return { json: flags.has("--json"), help: flags.has("--help") || flags.has("-h"), paths };
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`读不到或解析失败 ${path}: ${error.message}`);
  }
}

async function main() {
  const { json, help, paths } = parseArgs(process.argv.slice(2));
  if (help) {
    console.log(
      "用法：node scripts/check-dual-kernel-parity.mjs [--json] [canonicalPath] [capabilitiesPath]",
    );
    return;
  }
  const canonicalPath = resolve(paths[0] ?? DEFAULT_CANONICAL);
  const capabilitiesPath = resolve(paths[1] ?? DEFAULT_CAPABILITIES);

  let document;
  let capabilities;
  try {
    document = await readJson(canonicalPath);
    capabilities = await readJson(capabilitiesPath);
  } catch (error) {
    if (json) {
      console.log(JSON.stringify({ ok: false, errors: [error.message] }, null, 2));
    } else {
      console.error(`[dual-kernel-parity] FAIL ${error.message}`);
    }
    process.exit(1);
  }

  const errors = validateToolParity(document, capabilities);
  const counts = toolParityCounts(document, capabilities);
  if (json) {
    console.log(JSON.stringify({ ok: errors.length === 0, counts, errors }, null, 2));
    process.exit(errors.length === 0 ? 0 : 1);
  }

  if (errors.length > 0) {
    for (const message of errors) {
      console.error(`[dual-kernel-parity] FAIL ${message}`);
    }
    console.error(
      `[dual-kernel-parity] ${errors.length} 条命中（工具 ${counts.tools}，权限名 ${counts.permissions}，错误码 ${counts.errorCodes}）`,
    );
    process.exit(1);
  }

  console.log(
    `[dual-kernel-parity] PASS：工具 ${counts.tools}（both ${counts.bothTools} / node ${counts.nodeOnlyTools} / rust ${counts.rustOnlyTools}；` +
      `Node 覆盖 ${counts.nodeTools}、Rust 覆盖 ${counts.rustTools}）、权限名 ${counts.permissions}、` +
      `错误码 ${counts.errorCodes}（both ${counts.bothErrorCodes} / node ${counts.nodeOnlyErrorCodes} / rust ${counts.rustOnlyErrorCodes}）、` +
      `排除项 ${counts.excluded}、单侧例外 ${counts.exceptions}（${canonicalPath}）`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}