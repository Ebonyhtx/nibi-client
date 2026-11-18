// X02：Node 侧内置工具注册表与 kernel-contract/tool-parity.json 的机械对拍。
//
// 范围：apps/nibi-cli/packages/core/src/tool/handlers/index.ts 的 builtInTools。
// 动态 MCP / 插件工具不在这个静态清单里，排除项见 canonical 的 scope.excluded。
//
// 变异验证：下面的 mutation 用例直接改内存里的 canonical 文档，证明比较逻辑会红。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CoreErrorType } from "@nibi/contracts";
import { builtInTools } from "../src/tool/handlers/index.js";

interface CanonicalTool {
  name: string;
  side: "both" | "node" | "rust";
  permission?: string;
  readOnly?: boolean;
  nodeReadOnly?: boolean;
  rustReadOnly?: boolean;
  needsApproval?: boolean;
  alwaysAsk?: boolean;
  rustAsks?: boolean;
  note?: string;
}

interface CanonicalErrorCode {
  name: string;
  side: "both" | "node" | "rust";
  node?: string;
  rust?: string;
}

interface CanonicalDocument {
  version: number;
  counts: {
    tools: number;
    nodeTools: number;
    rustTools: number;
    permissions: number;
    errorCodes: number;
  };
  scope: {
    excluded: Array<{ name: string; side: "both" | "node" | "rust"; reason: string }>;
  };
  tools: CanonicalTool[];
  permissions: { side: "node" | "rust" | "both"; source: string; names: string[] };
  errorCodes: CanonicalErrorCode[];
}

interface NodeToolEntry {
  metadata: {
    name: string;
    readOnly: boolean;
    needsApproval: boolean;
  };
  permission: {
    permission: string;
    alwaysAsk?: true;
  };
  aliases?: readonly string[];
}

const CANONICAL_URL = new URL(
  "../../../../../packages/shared/src/kernel-contract/tool-parity.json",
  import.meta.url,
);
const canonical = JSON.parse(readFileSync(CANONICAL_URL, "utf8")) as CanonicalDocument;

function cloneDocument(): CanonicalDocument {
  return structuredClone(canonical);
}

function difference(actual: Iterable<string>, expected: Iterable<string>): string[] {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return [
    ...[...expectedSet].filter((name) => !actualSet.has(name)).map((name) => `missing:${name}`),
    ...[...actualSet].filter((name) => !expectedSet.has(name)).map((name) => `unexpected:${name}`),
  ].sort();
}

/**
 * 纯比较函数：门禁与 mutation 用例共用。返回错误消息；空数组表示一致。
 * @param document canonical 文档（可以是内存里被变异的副本）
 * @param entries 真实的 Node builtInTools 清单
 */
export function compareNodeRegistry(
  document: CanonicalDocument,
  entries: readonly NodeToolEntry[],
): string[] {
  const errors: string[] = [];
  const actualByName = new Map<string, NodeToolEntry>();
  for (const entry of entries) {
    if (actualByName.has(entry.metadata.name)) {
      errors.push(`duplicate node tool: ${entry.metadata.name}`);
    }
    actualByName.set(entry.metadata.name, entry);
  }

  const canonicalNodeTools = document.tools.filter(
    (tool) => tool.side === "both" || tool.side === "node",
  );
  const excludedNodeTools = document.scope.excluded.filter(
    (tool) => tool.side === "both" || tool.side === "node",
  );
  const expectedNames = new Set([
    ...canonicalNodeTools.map((tool) => tool.name),
    ...excludedNodeTools.map((tool) => tool.name),
  ]);
  errors.push(...difference(actualByName.keys(), expectedNames));

  for (const tool of canonicalNodeTools) {
    const entry = actualByName.get(tool.name);
    if (!entry) {
      errors.push(`${tool.name}: canonical 要求 Node 注册，但 builtInTools 里没有`);
      continue;
    }
    const readOnly = tool.nodeReadOnly ?? tool.readOnly;
    if (readOnly === undefined) {
      errors.push(`${tool.name}: canonical 缺少 readOnly/nodeReadOnly`);
    } else if (entry.metadata.readOnly !== readOnly) {
      errors.push(
        `${tool.name}: readOnly 漂移（canonical ${readOnly}，Node ${entry.metadata.readOnly}）`,
      );
    }
    if (tool.needsApproval === undefined) {
      errors.push(`${tool.name}: canonical 缺少 needsApproval`);
    } else if (entry.metadata.needsApproval !== tool.needsApproval) {
      errors.push(
        `${tool.name}: needsApproval 漂移（canonical ${tool.needsApproval}，Node ${entry.metadata.needsApproval}）`,
      );
    }
    const alwaysAsk = entry.permission.alwaysAsk === true;
    if (alwaysAsk !== (tool.alwaysAsk === true)) {
      errors.push(`${tool.name}: alwaysAsk 漂移（canonical ${tool.alwaysAsk === true}，Node ${alwaysAsk}）`);
    }
    if (!tool.permission) {
      errors.push(`${tool.name}: canonical 缺少 permission`);
    } else if (entry.permission.permission !== tool.permission) {
      errors.push(
        `${tool.name}: permission 漂移（canonical ${tool.permission}，Node ${entry.permission.permission}）`,
      );
    }
  }

  for (const tool of document.tools) {
    if (tool.side === "rust" && actualByName.has(tool.name)) {
      errors.push(`${tool.name}: canonical 标记为 Rust 单侧，但 Node builtInTools 注册了它`);
    }
  }

  for (const excluded of excludedNodeTools) {
    if (canonicalNodeTools.some((tool) => tool.name === excluded.name)) {
      errors.push(`${excluded.name}: 同时出现在 tools 与 scope.excluded`);
    }
    if (!actualByName.has(excluded.name)) {
      errors.push(`${excluded.name}: 已登记为 Node 排除项，但 Node builtInTools 里不存在`);
    }
  }

  return errors;
}

/** 权限分类名的独立比较：Node 全量 builtInTools（含跨层排除项）。 */
export function compareNodePermissionNames(
  document: CanonicalDocument,
  entries: readonly NodeToolEntry[],
): string[] {
  const actual = new Set(entries.map((entry) => entry.permission.permission));
  return difference(actual, document.permissions.names);
}

/** 错误码比较：Node 的 CoreErrorType 全量值。 */
export function compareNodeErrorCodes(
  document: CanonicalDocument,
  codeType: Record<string, string>,
): string[] {
  const actual = new Set(Object.values(codeType));
  const expected = new Set(
    document.errorCodes
      .filter((code) => code.side === "both" || code.side === "node")
      .map((code) => code.node)
      .filter((code): code is string => code !== undefined),
  );
  return difference(actual, expected);
}

describe("dual-kernel tool parity (Node side)", () => {
  it("canonical counts match the arrays", () => {
    expect(documentCountsAreConsistent(canonical)).toEqual([]);
  });

  it("builtInTools matches the canonical names, flags and permission names", () => {
    expect(compareNodeRegistry(canonical, builtInTools)).toEqual([]);
    expect(compareNodePermissionNames(canonical, builtInTools)).toEqual([]);
  });

  it("CoreErrorType matches the canonical node error codes", () => {
    expect(compareNodeErrorCodes(canonical, CoreErrorType)).toEqual([]);
  });

  it("mutation: deleting a canonical tool is red", () => {
    const mutated = cloneDocument();
    const index = mutated.tools.findIndex((tool) => tool.name === "Read");
    expect(index).toBeGreaterThanOrEqual(0);
    mutated.tools.splice(index, 1);
    expect(compareNodeRegistry(mutated, builtInTools).join("\n")).toContain("unexpected:Read");
  });

  it("mutation: flipping a readOnly flag is red", () => {
    const mutated = cloneDocument();
    const read = mutated.tools.find((tool) => tool.name === "Read");
    expect(read).toBeDefined();
    read!.readOnly = false;
    expect(compareNodeRegistry(mutated, builtInTools).join("\n")).toContain("Read: readOnly 漂移");
  });

  it("mutation: flipping a needsApproval flag is red", () => {
    const mutated = cloneDocument();
    const bash = mutated.tools.find((tool) => tool.name === "Bash");
    expect(bash).toBeDefined();
    bash!.needsApproval = false;
    expect(compareNodeRegistry(mutated, builtInTools).join("\n")).toContain(
      "Bash: needsApproval 漂移",
    );
  });

  it("mutation: deleting an excluded tool from the real registry is red", () => {
    const withoutSkill = builtInTools.filter((entry) => entry.metadata.name !== "Skill");
    expect(compareNodeRegistry(canonical, withoutSkill).join("\n")).toContain(
      "Skill: 已登记为 Node 排除项，但 Node builtInTools 里不存在",
    );
  });

  // TodoRead 已从 Node 单侧移到 both：Node 侧缺它时按“canonical 要求注册”判红（不再是排除项）。
  it("mutation: deleting a both tool from the real registry is red", () => {
    const withoutTodoRead = builtInTools.filter((entry) => entry.metadata.name !== "TodoRead");
    expect(compareNodeRegistry(canonical, withoutTodoRead).join("\n")).toContain(
      "TodoRead: canonical 要求 Node 注册，但 builtInTools 里没有",
    );
  });

  it("mutation: adding an unregistered tool to the registry is red", () => {
    const extra = {
      metadata: { name: "SurpriseTool", readOnly: true, needsApproval: false },
      permission: { permission: "read" },
    } satisfies NodeToolEntry;
    expect(compareNodeRegistry(canonical, [...builtInTools, extra]).join("\n")).toContain(
      "unexpected:SurpriseTool",
    );
  });

  it("mutation: a rust-only tool registered on Node is red", () => {
    const monitor = builtInTools.find((entry) => entry.metadata.name === "Monitor");
    expect(monitor).toBeUndefined();
    const extra = {
      metadata: { name: "Monitor", readOnly: false, needsApproval: false },
      permission: { permission: "read" },
    } satisfies NodeToolEntry;
    expect(compareNodeRegistry(canonical, [...builtInTools, extra]).join("\n")).toContain(
      "Monitor: canonical 标记为 Rust 单侧，但 Node builtInTools 注册了它",
    );
  });
});

function documentCountsAreConsistent(document: CanonicalDocument): string[] {
  const errors: string[] = [];
  const names = document.tools.map((tool) => tool.name);
  if (new Set(names).size !== names.length) {
    errors.push("tools 有重复 name");
  }
  const nodeTools = document.tools.filter((tool) => tool.side !== "rust").length;
  const rustTools = document.tools.filter((tool) => tool.side !== "node").length;
  if (document.counts.tools !== document.tools.length) {
    errors.push(`counts.tools ${document.counts.tools} != ${document.tools.length}`);
  }
  if (document.counts.nodeTools !== nodeTools) {
    errors.push(`counts.nodeTools ${document.counts.nodeTools} != ${nodeTools}`);
  }
  if (document.counts.rustTools !== rustTools) {
    errors.push(`counts.rustTools ${document.counts.rustTools} != ${rustTools}`);
  }
  if (document.counts.permissions !== document.permissions.names.length) {
    errors.push(`counts.permissions ${document.counts.permissions} != ${document.permissions.names.length}`);
  }
  if (new Set(document.permissions.names).size !== document.permissions.names.length) {
    errors.push("permissions 有重复 name");
  }
  if (document.counts.errorCodes !== document.errorCodes.length) {
    errors.push(`counts.errorCodes ${document.counts.errorCodes} != ${document.errorCodes.length}`);
  }
  if (new Set(document.errorCodes.map((code) => code.name)).size !== document.errorCodes.length) {
    errors.push("errorCodes 有重复 name");
  }
  return errors;
}