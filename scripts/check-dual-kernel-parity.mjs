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
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
const DEFAULT_CONTRACT_FIXTURE = join(HERE, "fixtures", "dual-kernel-tool-parity.json");
const NODE_CONTRACT_EXPORTER = join(HERE, "lib", "export-node-tool-contract.mjs");
const KERNEL_DIR = join(HERE, "..", "kernel");
const RUST_CONTRACT_TEST =
  "parity_tests::dump_tool_contract_for_dual_kernel_parity";
export const CONTRACT_FIXTURE_VERSION = 1;

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

// ============================================================
// X02 扩展：工具 input schema 与结果预算的可复现快照
//
// 快照（fixture）由 `--update` 从两侧源码/构建产物确定性生成：
//   - Node：src 的 builtInTools（tsx 载入；Read 按“支持 PDF”的固定模型投影取
//     resolveModelContract，见 scripts/lib/export-node-tool-contract.mjs）；
//   - Rust：`nibi-kernel-tools` 测试同款注册表，经
//     NIBI_DUAL_KERNEL_CONTRACT_OUT 导出。
// 注意：Node 的 builtInTools 自身从 src 载入，但它 import 的 @nibi/contracts 走
// package exports → dist。改了 contracts 的 schema 后，先
//   pnpm --filter @nibi/contracts build
// 再跑 --update / --check --live，否则比较的是旧 dist。
// `--check` 只读入库的 fixture 做跨内核比较，所以能放进不需要 pnpm install /
// cargo 的 policy job；两侧源码是否仍能生成同一份 fixture，由各自的测试独立断言：
//   - apps/nibi-cli/packages/core/tests/tool-parity.test.ts（Node，直接对比 fixture）
//   - kernel/crates/tools/src/parity_tests.rs（Rust，dump 入口 + 注册表对拍）
//
// 为什么不在桌面上做整机双跑：桌面本地 agent 已收口为唯一 Rust
// （`resolveKernelSelection` / `NIBI_KERNEL` 开关已删除，找不到 `nibi-rs` 时
// fail-closed，不再回落 node 链路；见 docs/rust-kernel-function-parity.md 开头）。
// 没有把同一桌面会话切到 Node 内核的入口，所以最小可复现对拍放在工具契约层：
//   node scripts/check-dual-kernel-parity.mjs --check --live
// 同一进程里分别导出两侧活契约再逐工具比较；Node 侧由 tsx 跑 src，Rust 侧由
// cargo test dump，二者都是各自真实注册表，不是手写期望值。
//
// 比较口径（写进 fixture 的 description，避免“看起来在比其实没比”）：
//   - schema：去掉 description/$schema/title/propertyNames/examples，折叠
//     oneOf/anyOf 的 type/min/max（integer 的 exclusive 边界折算成 inclusive），
//     enum/required/type 排序；比对 properties/required/constraints/items/
//     additionalProperties。
//   - 结果预算：只比较模型可见上限（Node maxModelChars 优先，否则
//     resultBudget.maxModelBytes；Rust max_result_size_chars）、是否有上限、
//     预览方向与 budget strategy。Node 的 metadata.maxOutputBytes 是宿主硬上限，
//     不是模型可见预算，登记在 fixture 之外，不参与跨内核比较。
// ============================================================

const BUDGET_FIELDS = [
  "resultBudget.bounded",
  "resultBudget.limit",
  "resultBudget.unit",
  "resultBudget.strategy",
  "resultBudget.direction",
];
const BUDGET_FIELD_SET = new Set(BUDGET_FIELDS);
const CONTRACT_DESCRIPTION =
  "X02 双内核工具 input schema 与结果预算快照。由 node scripts/check-dual-kernel-parity.mjs --update 生成；描述文本与 metadata.maxOutputBytes 不参与跨内核比较。";

export function stableClone(value) {
  if (Array.isArray(value)) return value.map(stableClone);
  if (value && typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).sort()) result[key] = stableClone(value[key]);
    return result;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableClone(value));
}

/** 供 freshness 测试用：fixture 写入时经过 stableClone，比较也必须同口径。 */
export { stableStringify };

function addSchemaTypes(schema, types) {
  if (!schema || typeof schema !== "object") return;
  if (typeof schema.type === "string") types.add(schema.type);
  else if (Array.isArray(schema.type)) {
    for (const type of schema.type) if (typeof type === "string") types.add(type);
  }
  for (const key of ["oneOf", "anyOf", "allOf"]) {
    if (!Array.isArray(schema[key])) continue;
    for (const member of schema[key]) addSchemaTypes(member, types);
  }
}

function schemaValue(schema, key) {
  if (schema && typeof schema === "object" && schema[key] !== undefined) return schema[key];
  for (const group of ["oneOf", "anyOf"]) {
    if (!Array.isArray(schema?.[group])) continue;
    const values = schema[group]
      .map((member) => member?.[key])
      .filter((value) => value !== undefined);
    if (values.length === 1) return values[0];
  }
  return undefined;
}

function collectSchemaEnums(schema, values) {
  if (!schema || typeof schema !== "object") return;
  if (Array.isArray(schema.enum)) {
    for (const value of schema.enum) values.set(stableStringify(value), value);
  }
  for (const group of ["oneOf", "anyOf"]) {
    if (!Array.isArray(schema[group])) continue;
    for (const member of schema[group]) collectSchemaEnums(member, values);
  }
}

function allOfMembers(schema) {
  return Array.isArray(schema?.allOf)
    ? schema.allOf.filter((member) => member && typeof member === "object")
    : [];
}

/** 把 JSON Schema 归一成表示无关的语义形状；门禁与两侧 freshness 测试共用同一口径。 */
export function normalizeToolSchema(schema) {
  if (schema === true || schema === false) return schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return stableClone(schema);
  }
  const types = new Set();
  addSchemaTypes(schema, types);
  const nullable = types.delete("null");
  const typeList = [...types].sort();
  const result = {};
  if (typeList.length === 1) result.type = typeList[0];
  else if (typeList.length > 1) result.type = typeList;
  if (nullable) result.nullable = true;

  let minimum = schemaValue(schema, "minimum");
  let exclusiveMinimum = schemaValue(schema, "exclusiveMinimum");
  if (typeList.length === 1 && typeList[0] === "integer") {
    const folded = [
      ...(minimum !== undefined ? [minimum] : []),
      ...(exclusiveMinimum !== undefined ? [exclusiveMinimum + 1] : []),
    ];
    if (folded.length > 0) minimum = Math.max(...folded);
    exclusiveMinimum = undefined;
  }
  if (minimum !== undefined) result.minimum = minimum;
  if (exclusiveMinimum !== undefined) result.exclusiveMinimum = exclusiveMinimum;

  let maximum = schemaValue(schema, "maximum");
  let exclusiveMaximum = schemaValue(schema, "exclusiveMaximum");
  if (typeList.length === 1 && typeList[0] === "integer") {
    const folded = [
      ...(maximum !== undefined ? [maximum] : []),
      ...(exclusiveMaximum !== undefined ? [exclusiveMaximum - 1] : []),
    ];
    if (folded.length > 0) maximum = Math.min(...folded);
    exclusiveMaximum = undefined;
  }
  if (maximum !== undefined) result.maximum = maximum;
  if (exclusiveMaximum !== undefined) result.exclusiveMaximum = exclusiveMaximum;

  for (const key of [
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "minProperties",
    "maxProperties",
    "pattern",
    "format",
    "const",
    "default",
  ]) {
    const value = schemaValue(schema, key);
    if (value !== undefined) result[key] = stableClone(value);
  }

  const enums = new Map();
  collectSchemaEnums(schema, enums);
  if (enums.size > 0) {
    result.enum = [...enums.keys()].sort().map((key) => enums.get(key));
  }

  const properties = {};
  const ownProperties =
    schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  for (const key of Object.keys(ownProperties).sort()) {
    properties[key] = normalizeToolSchema(ownProperties[key]);
  }
  for (const member of allOfMembers(schema)) {
    if (!member.properties || typeof member.properties !== "object") continue;
    for (const key of Object.keys(member.properties).sort()) {
      if (!(key in properties)) properties[key] = normalizeToolSchema(member.properties[key]);
    }
  }
  if (Object.keys(properties).length > 0) result.properties = properties;

  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  for (const member of allOfMembers(schema)) {
    if (!Array.isArray(member.required)) continue;
    for (const key of member.required) required.add(key);
  }
  if (required.size > 0) result.required = [...required].sort();

  if (schema.items !== undefined) result.items = normalizeToolSchema(schema.items);
  if (schema.additionalProperties !== undefined) {
    const additional = schema.additionalProperties;
    result.additionalProperties =
      additional === true ||
      (additional &&
        typeof additional === "object" &&
        Object.keys(additional).length === 0)
        ? true
        : additional === false
          ? false
          : normalizeToolSchema(additional);
  }
  return result;
}

/** 结构化 JSON diff：只报路径与两侧值，供 allowlist 精确匹配。 */
export function diffToolSchemas(nodeSchema, rustSchema, pointer = "") {
  if (stableStringify(nodeSchema) === stableStringify(rustSchema)) return [];
  const nodeObject =
    nodeSchema && typeof nodeSchema === "object" && !Array.isArray(nodeSchema);
  const rustObject =
    rustSchema && typeof rustSchema === "object" && !Array.isArray(rustSchema);
  if (nodeObject && rustObject) {
    const keys = new Set([...Object.keys(nodeSchema), ...Object.keys(rustSchema)]);
    return [...keys]
      .sort()
      .flatMap((key) => diffToolSchemas(nodeSchema[key], rustSchema[key], `${pointer}/${key}`));
  }
  return [{ pointer: pointer || "/", node: nodeSchema, rust: rustSchema }];
}

export function nodeResultBudgetFacts(entry) {
  const budget = entry?.resultBudget ?? null;
  const charLimit = Number.isFinite(entry?.maxModelChars) ? entry.maxModelChars : null;
  const byteLimit =
    budget && budget.strategy !== "inline" && Number.isFinite(budget.maxModelBytes)
      ? budget.maxModelBytes
      : null;
  const limit = charLimit ?? byteLimit;
  return {
    bounded: limit !== null,
    limit,
    unit: charLimit !== null ? "chars" : limit !== null ? "bytes" : null,
    strategy: limit !== null ? (budget?.strategy ?? null) : null,
    direction: limit !== null ? (budget?.preview?.direction ?? "head") : null,
  };
}

export function rustResultBudgetFacts(entry) {
  const limit = Number.isFinite(entry?.maxResultSizeChars)
    ? entry.maxResultSizeChars
    : null;
  return {
    bounded: limit !== null,
    limit,
    unit: limit !== null ? "chars" : null,
    strategy: limit !== null ? "artifact" : null,
    direction: limit !== null ? "head" : null,
  };
}

export function projectNodeContractTool(entry) {
  return {
    inputSchema: normalizeToolSchema(entry.inputSchema),
    resultBudget: entry.resultBudget ? stableClone(entry.resultBudget) : null,
    maxModelChars: Number.isFinite(entry.maxModelChars) ? entry.maxModelChars : null,
  };
}

export function projectRustContractTool(entry) {
  return {
    inputSchema: normalizeToolSchema(entry.inputSchema),
    maxResultSizeChars: Number.isFinite(entry.maxResultSizeChars)
      ? entry.maxResultSizeChars
      : null,
  };
}

function indexContractTools(tools, label, errors) {
  const byName = new Map();
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool !== "object" || !isNonEmptyString(tool.name)) {
      errors.push(`${label} 契约里有缺少 name 的条目`);
      continue;
    }
    if (byName.has(tool.name)) errors.push(`${label} 契约里 ${tool.name} 重复`);
    byName.set(tool.name, tool);
  }
  return byName;
}

/** 由两侧活契约 + canonical side 生成入库快照。 */
export function buildToolContractDocument({
  nodeTools,
  rustTools,
  canonical,
  allowlist = [],
}) {
  const errors = [];
  const nodeByName = indexContractTools(nodeTools, "Node", errors);
  const rustByName = indexContractTools(rustTools, "Rust", errors);
  const tools = {};
  const specs = Array.isArray(canonical?.tools) ? canonical.tools : [];
  for (const spec of [...specs].sort((left, right) => left.name.localeCompare(right.name))) {
    const nodeTool = nodeByName.get(spec.name);
    const rustTool = rustByName.get(spec.name);
    const wantsNode = spec.side === "both" || spec.side === "node";
    const wantsRust = spec.side === "both" || spec.side === "rust";
    if (wantsNode && !nodeTool) errors.push(`canonical 要求 Node 注册 ${spec.name}，但导出里没有`);
    if (wantsRust && !rustTool) errors.push(`canonical 要求 Rust 注册 ${spec.name}，但导出里没有`);
    if (!wantsNode && nodeTool) {
      errors.push(`canonical 标记 ${spec.name} 为 Rust 单侧，但 Node 导出里有它`);
    }
    if (!wantsRust && rustTool) {
      errors.push(`canonical 标记 ${spec.name} 为 Node 单侧，但 Rust 导出里有它`);
    }
    const record = { side: spec.side };
    if (wantsNode && nodeTool) record.node = projectNodeContractTool(nodeTool);
    if (wantsRust && rustTool) record.rust = projectRustContractTool(rustTool);
    tools[spec.name] = record;
  }
  return {
    document: {
      version: CONTRACT_FIXTURE_VERSION,
      description: CONTRACT_DESCRIPTION,
      generatedBy: "node scripts/check-dual-kernel-parity.mjs --update",
      tools,
      allowlist: stableClone(allowlist),
    },
    errors,
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validateContractAllowlist(allowlist, { today = new Date() } = {}) {
  const errors = [];
  if (!Array.isArray(allowlist)) return ["allowlist 必须是数组（没有例外也显式写空数组）"];
  const todayIso = today.toISOString().slice(0, 10);
  const seen = new Set();
  for (const [index, entry] of allowlist.entries()) {
    const where = `allowlist[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${where} 必须是对象`);
      continue;
    }
    if (!isNonEmptyString(entry.tool)) {
      errors.push(`${where}.tool 必须是非空字符串（全局例外写 "*"）`);
    }
    if (!BUDGET_FIELD_SET.has(entry.field) && entry.field !== "inputSchema") {
      errors.push(
        `${where}.field 必须是 inputSchema / ${BUDGET_FIELDS.join(" / ")}（当前 ${JSON.stringify(entry.field)}）`,
      );
    }
    if (entry.field === "inputSchema") {
      if (!isNonEmptyString(entry.pointer)) {
        errors.push(`${where}.pointer 必须是非空字符串（精确路径、"*" 或 "/prefix/*"）`);
      } else if (
        entry.pointer !== "*" &&
        !entry.pointer.startsWith("/") &&
        !entry.pointer.endsWith("/*")
      ) {
        errors.push(`${where}.pointer 必须以 "/" 开头，或写 "*"（当前 ${entry.pointer}）`);
      }
    } else if (entry.pointer !== undefined) {
      errors.push(`${where} 是结果预算例外，不应写 pointer`);
    }
    if (!isNonEmptyString(entry.reason)) {
      errors.push(`${where}.reason 必须是非空字符串（写清为什么允许差异）`);
    }
    if (!isNonEmptyString(entry.reviewAfter) || !/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewAfter)) {
      errors.push(`${where}.reviewAfter 必须是 YYYY-MM-DD（到期复核日期）`);
    } else if (entry.reviewAfter < todayIso) {
      errors.push(`${where}.reviewAfter ${entry.reviewAfter} 已过期（今天 ${todayIso}），必须复核`);
    }
    const key = `${entry.tool}\u0000${entry.field}\u0000${entry.pointer ?? ""}`;
    if (seen.has(key)) errors.push(`${where} 与前面的 allowlist 条目重复`);
    seen.add(key);
  }
  return errors;
}

function validateContractDocumentStructure(document) {
  const errors = [];
  if (!isPlainObject(document)) return ["tool contract fixture 必须是 JSON 对象"];
  if (document.version !== CONTRACT_FIXTURE_VERSION) {
    errors.push(`version 必须是 ${CONTRACT_FIXTURE_VERSION}`);
  }
  if (!isNonEmptyString(document.description)) errors.push("description 必须是非空字符串");
  if (!isNonEmptyString(document.generatedBy)) errors.push("generatedBy 必须是非空字符串");
  if (!isPlainObject(document.tools) || Object.keys(document.tools).length === 0) {
    errors.push("tools 必须是非空对象");
    return errors;
  }
  for (const [name, record] of Object.entries(document.tools)) {
    if (!isPlainObject(record)) {
      errors.push(`tools.${name} 必须是对象`);
      continue;
    }
    if (!ALLOWED_SIDES.has(record.side)) {
      errors.push(`tools.${name}.side 必须是 both / node / rust`);
      continue;
    }
    if ((record.side === "both" || record.side === "node") && !isPlainObject(record.node)) {
      errors.push(`tools.${name} 缺 node 契约`);
    }
    if ((record.side === "both" || record.side === "rust") && !isPlainObject(record.rust)) {
      errors.push(`tools.${name} 缺 rust 契约`);
    }
    if (record.side === "rust" && record.node !== undefined) {
      errors.push(`tools.${name} 是 Rust 单侧，不应有 node 契约`);
    }
    if (record.side === "node" && record.rust !== undefined) {
      errors.push(`tools.${name} 是 Node 单侧，不应有 rust 契约`);
    }
    if (record.node !== undefined) {
      if (!isPlainObject(record.node.inputSchema)) {
        errors.push(`tools.${name}.node.inputSchema 必须是对象`);
      }
      if (
        record.node.resultBudget !== null &&
        !isPlainObject(record.node.resultBudget)
      ) {
        errors.push(`tools.${name}.node.resultBudget 必须是对象或 null`);
      }
      if (
        record.node.maxModelChars !== null &&
        !Number.isInteger(record.node.maxModelChars)
      ) {
        errors.push(`tools.${name}.node.maxModelChars 必须是整数或 null`);
      }
    }
    if (record.rust !== undefined) {
      if (!isPlainObject(record.rust.inputSchema)) {
        errors.push(`tools.${name}.rust.inputSchema 必须是对象`);
      }
      if (
        record.rust.maxResultSizeChars !== null &&
        !Number.isInteger(record.rust.maxResultSizeChars)
      ) {
        errors.push(`tools.${name}.rust.maxResultSizeChars 必须是整数或 null`);
      }
    }
  }
  errors.push(...validateContractAllowlist(document.allowlist));
  return errors;
}

function formatDifference(difference) {
  const pointer = difference.pointer ? ` ${difference.pointer}` : "";
  // 单侧缺 key 时 JSON.stringify(undefined) 返回 undefined，不能直接读 length。
  const render = (value) => {
    const text = JSON.stringify(value);
    return text === undefined ? "undefined" : text;
  };
  const node = render(difference.node);
  const rust = render(difference.rust);
  const cut = (value) => (value.length > 160 ? `${value.slice(0, 157)}...` : value);
  return `${difference.tool} ${difference.field}${pointer}: node=${cut(node)} rust=${cut(rust)}（未在 allowlist 登记）`;
}

function pointerMatches(pattern, pointer) {
  if (pattern === "*") return true;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    return pointer === prefix || pointer.startsWith(`${prefix}/`);
  }
  return pattern === pointer;
}

function allowlistMatches(entry, difference) {
  if (entry.tool !== "*" && entry.tool !== difference.tool) return false;
  if (entry.field !== difference.field) return false;
  if (difference.field === "inputSchema") {
    return pointerMatches(entry.pointer, difference.pointer);
  }
  return true;
}

/**
 * 跨内核对拍：fixture 的 Node/Rust 两侧逐工具比较，差异必须命中显式 allowlist。
 * 返回 {ok, errors, differences, allowlisted, allowlistEntries}。
 */
export function compareToolContracts(document, { today = new Date() } = {}) {
  const structural = validateContractDocumentStructure(document);
  if (structural.length > 0) {
    return {
      ok: false,
      errors: structural,
      differences: [],
      allowlisted: 0,
      allowlistEntries: Array.isArray(document?.allowlist)
        ? document.allowlist.length
        : 0,
    };
  }
  const differences = [];
  for (const [name, record] of Object.entries(document.tools).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!record.node || !record.rust) continue;
    for (const difference of diffToolSchemas(
      record.node.inputSchema,
      record.rust.inputSchema,
    )) {
      differences.push({ tool: name, field: "inputSchema", ...difference });
    }
    const nodeFacts = nodeResultBudgetFacts(record.node);
    const rustFacts = rustResultBudgetFacts(record.rust);
    if (nodeFacts.bounded !== rustFacts.bounded) {
      // bounded 是根差异；limit/unit/strategy/direction 都是从它派生出来的，不再重复报。
      differences.push({
        tool: name,
        field: "resultBudget.bounded",
        node: nodeFacts.bounded,
        rust: rustFacts.bounded,
      });
      continue;
    }
    for (const field of ["limit", "unit", "strategy", "direction"]) {
      if (nodeFacts[field] !== rustFacts[field]) {
        differences.push({
          tool: name,
          field: `resultBudget.${field}`,
          node: nodeFacts[field],
          rust: rustFacts[field],
        });
      }
    }
  }

  const errors = [];
  const used = new Set();
  let allowlisted = 0;
  for (const difference of differences) {
    const matches = document.allowlist
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => allowlistMatches(entry, difference));
    if (matches.length === 0) {
      errors.push(formatDifference(difference));
      continue;
    }
    allowlisted += 1;
    for (const { index } of matches) used.add(index);
  }
  for (const [index, entry] of document.allowlist.entries()) {
    if (!used.has(index)) {
      errors.push(
        `allowlist[${index}] ${entry.tool} ${entry.field}${entry.pointer ? ` ${entry.pointer}` : ""} 未命中任何差异（陈旧登记，删掉或修准）`,
      );
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    differences,
    allowlisted,
    allowlistEntries: document.allowlist.length,
  };
}

function contractSnapshotDrift(fixture, live) {
  const errors = [];
  const names = new Set([
    ...Object.keys(fixture.tools ?? {}),
    ...Object.keys(live.tools ?? {}),
  ]);
  for (const name of [...names].sort()) {
    const left = fixture.tools?.[name];
    const right = live.tools?.[name];
    if (!left || !right) {
      errors.push(`${name}: fixture ${left ? "有" : "没有"}，活契约 ${right ? "有" : "没有"}`);
      continue;
    }
    if (stableStringify(left) !== stableStringify(right)) {
      errors.push(`${name}: fixture 与活契约不一致（先确认差异是否该走 allowlist，再 --update）`);
    }
  }
  return errors;
}

function parseContractJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} 输出的不是 JSON：${error.message}`);
  }
}

function runCommand(command, args, { cwd, env, timeoutMs, label }) {
  return new Promise((resolveRun, rejectRun) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      finish(
        rejectRun,
        new Error(`${label} 超时（${Math.round(timeoutMs / 1000)}s）`),
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(rejectRun, new Error(`${label} 启动失败：${error.message}`));
    });
    child.on("close", (code) => {
      finish(resolveRun, { code, stdout, stderr });
    });
  });
}

function tail(text, lines = 12) {
  return text.split(/\r?\n/).slice(-lines).join("\n");
}

export async function extractNodeToolContract() {
  const result = await runCommand(
    process.execPath,
    ["--import", "tsx", NODE_CONTRACT_EXPORTER],
    {
      cwd: resolve(HERE, ".."),
      timeoutMs: 120_000,
      label: "Node 工具契约导出",
    },
  );
  if (result.code !== 0) {
    throw new Error(
      `Node 工具契约导出失败（exit ${result.code}）；先确认 pnpm install 完成：\n${tail(result.stderr)}`,
    );
  }
  return parseContractJson(result.stdout, "Node 工具契约导出");
}

export async function extractRustToolContract() {
  const outputPath = join(
    tmpdir(),
    `nibi-rust-tool-contract-${process.pid}-${Date.now()}.json`,
  );
  try {
    const result = await runCommand(
      "cargo",
      [
        "test",
        "--locked",
        "--offline",
        "-p",
        "nibi-kernel-tools",
        "--lib",
        RUST_CONTRACT_TEST,
        "--",
        "--exact",
        "--nocapture",
      ],
      {
        cwd: KERNEL_DIR,
        env: { NIBI_DUAL_KERNEL_CONTRACT_OUT: outputPath },
        timeoutMs: 600_000,
        label: "Rust 工具契约导出",
      },
    );
    if (result.code !== 0) {
      throw new Error(
        `Rust 工具契约导出失败（exit ${result.code}）；需要可离线编译的 cargo 与 kernel/target：\n${tail(result.stderr)}`,
      );
    }
    if (!existsSync(outputPath)) {
      throw new Error(
        `Rust 工具契约导出没有写文件 ${outputPath}；确认 ${RUST_CONTRACT_TEST} 已被 cargo 执行`,
      );
    }
    return parseContractJson(await readFile(outputPath, "utf8"), "Rust 工具契约导出");
  } finally {
    await rm(outputPath, { force: true });
  }
}

async function loadCanonicalDocument() {
  return readJson(DEFAULT_CANONICAL);
}

async function readFixture(fixturePath) {
  if (!existsSync(fixturePath)) {
    throw new Error(
      `找不到 contract fixture ${fixturePath}；先跑 node scripts/check-dual-kernel-parity.mjs --update`,
    );
  }
  return parseContractJson(await readFile(fixturePath, "utf8"), "contract fixture");
}

async function writeFixture(fixturePath, document) {
  const directory = dirname(fixturePath);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(directory, { recursive: true });
  await writeFile(fixturePath, `${JSON.stringify(stableClone(document), null, 2)}\n`, "utf8");
}

async function updateContractFixture(fixturePath) {
  let previousAllowlist = [];
  if (existsSync(fixturePath)) {
    try {
      previousAllowlist = (await readFixture(fixturePath)).allowlist ?? [];
    } catch (error) {
      console.error(`[dual-kernel-parity] 旧 fixture 读不了，allowlist 从空开始：${error.message}`);
    }
  }
  const canonical = await loadCanonicalDocument();
  const [nodeContract, rustContract] = await Promise.all([
    extractNodeToolContract(),
    extractRustToolContract(),
  ]);
  const { document, errors } = buildToolContractDocument({
    nodeTools: nodeContract.tools,
    rustTools: rustContract.tools,
    canonical,
    allowlist: previousAllowlist,
  });
  await writeFixture(fixturePath, document);
  const comparison = compareToolContracts(document);
  const allErrors = [...errors, ...comparison.errors];
  console.log(
    `[dual-kernel-parity] 已写入 ${fixturePath}：工具 ${Object.keys(document.tools).length}，` +
      `跨内核差异 ${comparison.differences.length}，allowlist 命中 ${comparison.allowlisted}/${comparison.allowlistEntries}`,
  );
  if (allErrors.length > 0) {
    for (const message of allErrors) {
      console.error(`[dual-kernel-parity] FAIL ${message}`);
    }
    console.error(
      `[dual-kernel-parity] --update 已完成写入，但 ${allErrors.length} 条未收口；把真实差异按 tool/field 写入 allowlist（含 reason 与 reviewAfter）后重跑`,
    );
    return 1;
  }
  console.log("[dual-kernel-parity] PASS：contract fixture 已更新且全部差异都有 allowlist");
  return 0;
}

async function checkContractFixture(fixturePath, { live, json }) {
  let fixture;
  let liveErrors = [];
  try {
    fixture = await readFixture(fixturePath);
    if (live) {
      const canonical = await loadCanonicalDocument();
      const [nodeContract, rustContract] = await Promise.all([
        extractNodeToolContract(),
        extractRustToolContract(),
      ]);
      const { document: liveDocument, errors } = buildToolContractDocument({
        nodeTools: nodeContract.tools,
        rustTools: rustContract.tools,
        canonical,
        allowlist: fixture.allowlist ?? [],
      });
      liveErrors = [...errors, ...contractSnapshotDrift(fixture, liveDocument)];
    }
  } catch (error) {
    if (json) {
      console.log(JSON.stringify({ ok: false, errors: [error.message] }, null, 2));
    } else {
      console.error(`[dual-kernel-parity] FAIL ${error.message}`);
    }
    return 1;
  }
  const comparison = compareToolContracts(fixture);
  const errors = [...liveErrors, ...comparison.errors];
  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: errors.length === 0,
          live: Boolean(live),
          fixture: fixturePath,
          tools: Object.keys(fixture.tools ?? {}).length,
          differences: comparison.differences.length,
          allowlisted: comparison.allowlisted,
          allowlistEntries: comparison.allowlistEntries,
          errors,
        },
        null,
        2,
      ),
    );
    return errors.length === 0 ? 0 : 1;
  }
  if (errors.length > 0) {
    for (const message of errors) {
      console.error(`[dual-kernel-parity] FAIL ${message}`);
    }
    console.error(
      `[dual-kernel-parity] ${errors.length} 条命中（工具 ${Object.keys(fixture.tools ?? {}).length}，差异 ${comparison.differences.length}，allowlist ${comparison.allowlistEntries}）`,
    );
    return 1;
  }
  console.log(
    `[dual-kernel-parity] PASS：schema/结果预算 fixture ${Object.keys(fixture.tools ?? {}).length} 个工具，` +
      `跨内核差异 ${comparison.differences.length} 全部命中 allowlist ${comparison.allowlisted}/${comparison.allowlistEntries}` +
      `${live ? "；活契约与 fixture 一致" : ""}（${fixturePath}）`,
  );
  return 0;
}

function firstComparableTool(document) {
  return Object.entries(document.tools).find(
    ([, record]) => record.node && record.rust,
  )?.[0];
}

/** 变异自测：不依赖 cargo/tsx，证明未登记差异、过期/陈旧 allowlist 都会让门禁变红。 */
export function runContractSelftest(document, { today = new Date() } = {}) {
  const results = [];
  const check = (label, mutate, expectPattern) => {
    const copy = structuredClone(document);
    mutate(copy);
    const comparison = compareToolContracts(copy, { today });
    const caught =
      !comparison.ok &&
      comparison.errors.some((message) =>
        typeof expectPattern === "string"
          ? message.includes(expectPattern)
          : expectPattern.test(message),
      );
    results.push({ label, caught, errors: comparison.errors });
  };

  const baseline = compareToolContracts(document, { today });
  results.push({ label: "baseline fixture 通过", caught: baseline.ok, errors: baseline.errors });

  const schemaTool = firstComparableTool(document);
  check(
    "未登记 schema 差异变红",
    (copy) => {
      if (!schemaTool) return;
      const record = copy.tools[schemaTool];
      record.rust.inputSchema.properties = {
        ...(record.rust.inputSchema.properties ?? {}),
        __x02_selftest: { type: "string" },
      };
    },
    "inputSchema",
  );

  // 选一个「两侧 bounded 相同、且 maxModelChars/resultBudget 数值已经一致」的工具：
  // 它没有逐工具的 limit 例外，改大 maxModelBytes 后必须出现未登记的 limit 差异。
  const allowlistedLimitTools = new Set(
    document.allowlist
      .filter((entry) => entry.field === "resultBudget.limit")
      .map((entry) => entry.tool),
  );
  const budgetTool = Object.entries(document.tools).find(
    ([name, record]) =>
      record.node &&
      record.rust &&
      !allowlistedLimitTools.has(name) &&
      nodeResultBudgetFacts(record.node).bounded ===
        rustResultBudgetFacts(record.rust).bounded,
  )?.[0];
  check(
    "未登记结果预算差异变红",
    (copy) => {
      if (!budgetTool) return;
      const node = copy.tools[budgetTool].node;
      node.resultBudget = {
        ...(node.resultBudget ?? { strategy: "truncate" }),
        strategy: "truncate",
        maxModelBytes: 123_456_789,
        maxInlineBytes: 123_456_789,
      };
      node.maxModelChars = null;
    },
    "resultBudget.limit",
  );

  check(
    "过期 allowlist 变红",
    (copy) => {
      if (!copy.allowlist[0]) {
        copy.allowlist.push({
          tool: "*",
          field: "resultBudget.unit",
          reason: "selftest",
          reviewAfter: "2099-01-01",
        });
      }
      copy.allowlist[0].reviewAfter = "2000-01-01";
    },
    "已过期",
  );

  check(
    "空理由的 allowlist 变红",
    (copy) => {
      if (!copy.allowlist[0]) {
        copy.allowlist.push({
          tool: "*",
          field: "resultBudget.unit",
          reason: "selftest",
          reviewAfter: "2099-01-01",
        });
      }
      copy.allowlist[0].reason = "";
    },
    "reason",
  );

  check(
    "陈旧 allowlist 变红",
    (copy) => {
      // 用一个不可能命中任何工具的名字：全局 "*" 条目现在会合法命中 limit/unit 差异，
      // 不能再拿它当“陈旧”样本。
      copy.allowlist.push({
        tool: "__x02_selftest_stale_tool__",
        field: "resultBudget.limit",
        reason: "selftest 未命中",
        reviewAfter: "2099-01-01",
      });
    },
    "陈旧登记",
  );

  const usedEntryIndex = document.allowlist.findIndex((entry) =>
    compareToolContracts(document, { today }).differences.some((difference) =>
      allowlistMatches(entry, difference),
    ),
  );
  if (usedEntryIndex >= 0) {
    check(
      "删除已命中的 allowlist 后差异变红",
      (copy) => {
        copy.allowlist.splice(usedEntryIndex, 1);
      },
      "未在 allowlist 登记",
    );
  }

  if (schemaTool) {
    const copy = structuredClone(document);
    const record = copy.tools[schemaTool];
    record.rust.inputSchema.properties = {
      ...(record.rust.inputSchema.properties ?? {}),
      __x02_selftest: { type: "string" },
    };
    copy.allowlist.push({
      tool: schemaTool,
      field: "inputSchema",
      pointer: "/properties/__x02_selftest",
      reason: "selftest：登记后应恢复绿色",
      reviewAfter: "2099-01-01",
    });
    const comparison = compareToolContracts(copy, { today });
    results.push({
      label: "登记 allowlist 后新增差异恢复绿色",
      caught: comparison.ok,
      errors: comparison.errors,
    });
  }

  const failures = results.filter((result) => !result.caught);
  return { ok: failures.length === 0, results };
}

function parseArgs(argv) {
  const options = {
    mode: "legacy",
    json: false,
    help: false,
    live: false,
    fixture: null,
    paths: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--live") options.live = true;
    else if (argument === "--update") {
      if (options.mode !== "legacy") throw new Error("--update/--check/--selftest 只能选一个");
      options.mode = "update";
    } else if (argument === "--check") {
      if (options.mode !== "legacy") throw new Error("--update/--check/--selftest 只能选一个");
      options.mode = "check";
    } else if (argument === "--selftest") {
      if (options.mode !== "legacy") throw new Error("--update/--check/--selftest 只能选一个");
      options.mode = "selftest";
    } else if (argument === "--fixture") {
      index += 1;
      if (!argv[index]) throw new Error("--fixture 需要路径");
      options.fixture = argv[index];
    } else if (argument.startsWith("--fixture=")) {
      options.fixture = argument.slice("--fixture=".length);
    } else if (argument.startsWith("--")) {
      throw new Error(`未知参数 ${argument}`);
    } else {
      options.paths.push(argument);
    }
  }
  if (options.mode === "legacy" && (options.live || options.fixture)) {
    throw new Error("--live/--fixture 只用于 --check / --update / --selftest");
  }
  if (options.mode === "update" && options.live) {
    throw new Error("--update 已经会重新导出活契约，不要再加 --live");
  }
  if (options.mode === "selftest" && options.live) {
    throw new Error("--selftest 不导出活契约，不能用 --live");
  }
  return options;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`读不到或解析失败 ${path}: ${error.message}`);
  }
}

function printHelp() {
  console.log(`用法：
  node scripts/check-dual-kernel-parity.mjs [--json] [canonicalPath] [capabilitiesPath]
      结构化清单门禁（工具名/权限/错误码），默认模式。

  node scripts/check-dual-kernel-parity.mjs --check [--json] [--live] [--fixture <path>]
      比较入库的工具 input schema / 结果预算 fixture；差异必须命中 allowlist。
      --live  另外重新导出 Node/Rust 活契约，检查 fixture 是否已过期（需要 pnpm + cargo）。

  node scripts/check-dual-kernel-parity.mjs --update [--fixture <path>]
      从源码重新生成 fixture（Node: tsx 载入 src；Rust: cargo test 导出）。
      未登记的差异或陈旧/过期 allowlist 会让命令以 1 退出，写完也不放行。

  node scripts/check-dual-kernel-parity.mjs --selftest [--json] [--fixture <path>]
      变异自测：证明未登记差异、过期/陈旧 allowlist 会让门禁变红（不跑 cargo/tsx）。`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.mode === "update") {
    const fixturePath = resolve(
      options.fixture ?? options.paths[0] ?? DEFAULT_CONTRACT_FIXTURE,
    );
    process.exit(await updateContractFixture(fixturePath));
  }
  if (options.mode === "check") {
    const fixturePath = resolve(
      options.fixture ?? options.paths[0] ?? DEFAULT_CONTRACT_FIXTURE,
    );
    process.exit(
      await checkContractFixture(fixturePath, {
        live: options.live,
        json: options.json,
      }),
    );
  }
  if (options.mode === "selftest") {
    const fixturePath = resolve(
      options.fixture ?? options.paths[0] ?? DEFAULT_CONTRACT_FIXTURE,
    );
    let fixture;
    try {
      fixture = await readFixture(fixturePath);
    } catch (error) {
      if (options.json) {
        console.log(JSON.stringify({ ok: false, errors: [error.message] }, null, 2));
      } else {
        console.error(`[dual-kernel-parity] FAIL ${error.message}`);
      }
      process.exit(1);
    }
    const selftest = runContractSelftest(fixture);
    if (options.json) {
      console.log(JSON.stringify(selftest, null, 2));
    } else {
      for (const result of selftest.results) {
        console.log(
          `[dual-kernel-parity] ${result.caught ? "PASS" : "FAIL"} selftest: ${result.label}`,
        );
        if (!result.caught) {
          for (const message of result.errors) {
            console.error(`  - ${message}`);
          }
        }
      }
      console.log(
        selftest.ok
          ? `[dual-kernel-parity] SELFTEST PASS（${selftest.results.length}/${selftest.results.length} 变异被拦住）`
          : "[dual-kernel-parity] SELFTEST FAIL",
      );
    }
    process.exit(selftest.ok ? 0 : 1);
  }

  const { json, paths } = options;
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