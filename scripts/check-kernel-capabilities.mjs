#!/usr/bin/env node
/**
 * 判据：双内核能力单侧例外登记表必须完整、可读、无重复。
 *
 * 为什么单独一条：Rust 与 Node 不是所有能力都双实现（DWF 预算、V8 内存诊断、
 * 扩展宿主、远端 agent 只在一侧）。没有登记表时，差异会藏在代码里，UI 只能猜
 * “当前内核不支持”。本门禁只校验登记表的结构；行为一致性由各自测试覆盖。
 *
 * 单一来源：packages/shared/src/kernel-contract/capabilities.json。
 * 用法：node scripts/check-kernel-capabilities.mjs [registryPath]
 * 退出码：0 = 通过；1 = 有命中。
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REGISTRY = join(
  HERE,
  "..",
  "packages",
  "shared",
  "src",
  "kernel-contract",
  "capabilities.json",
);

export const ALLOWED_SIDES = new Set(["rust", "node", "host"]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 纯校验函数：给门禁与单测共用，避免“门禁自己就是唯一实现”。
 * 返回错误消息数组；空数组表示通过。
 */
export function validateCapabilities(document) {
  const errors = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return ["登记表必须是 JSON 对象"];
  }
  if (document.version !== 1) {
    errors.push(`version 必须是 1（当前 ${JSON.stringify(document.version)}）`);
  }

  const singleSide = document.singleSideExceptions;
  if (!Array.isArray(singleSide) || singleSide.length === 0) {
    errors.push("singleSideExceptions 必须是非空数组（没有例外也要显式写明，不能空转）");
  }

  const dual = document.dualImplementation;
  if (!Array.isArray(dual) || dual.length === 0) {
    errors.push("dualImplementation 必须是非空数组（至少登记 promptSnapshot）");
  }

  const seen = new Set();
  const checkEntry = (entry, label, index) => {
    const where = `${label}[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`${where} 必须是对象`);
      return;
    }
    if (!isNonEmptyString(entry.capability)) {
      errors.push(`${where}.capability 必须是非空字符串`);
      return;
    }
    if (seen.has(entry.capability)) {
      errors.push(`${where}.capability ${entry.capability} 重复登记`);
    }
    seen.add(entry.capability);
    if (!isNonEmptyString(entry.reason)) {
      errors.push(`${where}.reason 必须是非空字符串`);
    }
  };

  if (Array.isArray(singleSide)) {
    singleSide.forEach((entry, index) => {
      checkEntry(entry, "singleSideExceptions", index);
      if (entry && typeof entry === "object" && !ALLOWED_SIDES.has(entry.side)) {
        errors.push(
          `singleSideExceptions[${index}].side 必须是 rust / node / host（当前 ${JSON.stringify(entry.side)}）`,
        );
      }
    });
  }
  if (Array.isArray(dual)) {
    dual.forEach((entry, index) => checkEntry(entry, "dualImplementation", index));
  }

  return errors;
}

async function main() {
  const registryPath = resolve(process.argv[2] ?? DEFAULT_REGISTRY);
  let document;
  try {
    document = JSON.parse(await readFile(registryPath, "utf8"));
  } catch (error) {
    console.error(`[kernel-capabilities] 读不到或解析失败 ${registryPath}: ${error.message}`);
    process.exit(1);
  }

  const errors = validateCapabilities(document);
  if (errors.length > 0) {
    for (const message of errors) {
      console.error(`[kernel-capabilities] FAIL ${message}`);
    }
    console.error(`[kernel-capabilities] ${errors.length} 条命中`);
    process.exit(1);
  }

  console.log(
    `[kernel-capabilities] PASS：${document.singleSideExceptions.length} 条单侧例外、` +
      `${document.dualImplementation.length} 条双实现登记（${registryPath}）`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
