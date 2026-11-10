import type { ConversationRow, ToolCallRow } from "@nibi/shared/nibi-protocol-v4";
import { resolvePluginUiLogicalScope } from "./pluginUiLogicalScope.js";

/** ：最近几个回合的插件卡片默认展开，更早的按默认收进折叠区。 */
export const PLUGIN_UI_AUTO_EXPAND_TURNS = 3;

/** 一个逻辑 UI：仅显式 surface 或权限范围一致的 widgetSessionId 共用，其余调用独立。 */
export interface PluginUiLogicalInstance {
  key: string;
  /** 当前显示的调用：最新一次成功（非 isError）的；没有成功的就是最新一条。 */
  activeToolCallId: string;
  /** 被较新成功结果替代的成功调用；它们不建沙箱，只保留普通工具记录。 */
  supersededToolCallIds: string[];
}

/** 单条插件工具行的展示裁决；渲染层据此决定进不进折叠区、要不要建沙箱。 */
export interface PluginUiRowDisposition {
  key: string;
  superseded: boolean;
  /** 所在回合在最近 PLUGIN_UI_AUTO_EXPAND_TURNS 个回合内。 */
  autoExpand: boolean;
  /** 工具级 `openai/widgetShowCodexWidgetInline`（display.ui.showInline）。 */
  forcedInline: boolean;
}

export interface PluginUiInstanceDerivation {
  instances: PluginUiLogicalInstance[];
  byToolCallId: Readonly<Record<string, PluginUiRowDisposition>>;
}

export const EMPTY_PLUGIN_UI_INSTANCE_DERIVATION: PluginUiInstanceDerivation = {
  instances: [],
  byToolCallId: {},
};

function isPluginUiToolRow(row: ConversationRow): row is ToolCallRow {
  return (
    row.kind === "toolCall" && row.display?.kind === "mcp_tool" && row.display.ui !== undefined
  );
}

function isSuccessfulUiRow(row: ToolCallRow): boolean {
  return (
    row.status === "success" &&
    !(row.display?.kind === "mcp_tool" && row.display.ui?.isError === true)
  );
}

interface LogicalUiDerivationInputs {
  /** 回合首次出现顺序；autoExpand 只看最近 N 个回合，与正文更新无关。 */
  turnOrder: string[];
  /** 全部插件 UI 工具行，保持投影顺序；正文/普通工具更新不改变它们。 */
  pluginRows: ToolCallRow[];
  autoExpandTurns: number;
}

let lastInputs: LogicalUiDerivationInputs | null = null;
let lastDerivation: PluginUiInstanceDerivation | null = null;

function hasSameStrings(previous: readonly string[], next: readonly string[]): boolean {
  if (previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

function hasSameRows(previous: readonly ToolCallRow[], next: readonly ToolCallRow[]): boolean {
  if (previous.length !== next.length) return false;
  for (let index = 0; index < next.length; index += 1) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

function deriveFromInputs({
  turnOrder,
  pluginRows,
  autoExpandTurns,
}: LogicalUiDerivationInputs): PluginUiInstanceDerivation {
  const recentTurns = turnOrder.slice(-autoExpandTurns);
  const groupKeys: string[] = [];
  const groups: Record<string, ToolCallRow[]> = {};
  for (const row of pluginRows) {
    const display = row.display;
    if (display?.kind !== "mcp_tool" || !display.ui) continue;
    const logical = resolvePluginUiLogicalScope(display.ui, {
      kind: "toolCall",
      toolCallId: row.toolCallId,
    });
    const key = JSON.stringify([
      display.ui.pluginId,
      display.serverName,
      display.ui.resourceUri,
      logical,
    ]);
    const group = groups[key];
    if (group) group.push(row);
    else {
      groups[key] = [row];
      groupKeys.push(key);
    }
  }
  const instances: PluginUiLogicalInstance[] = [];
  const byToolCallId: Record<string, PluginUiRowDisposition> = {};
  for (const key of groupKeys) {
    const group = groups[key]!;
    const successes = group.filter(isSuccessfulUiRow);
    const active = successes.at(-1) ?? group.at(-1)!;
    const superseded = successes.filter((row) => row !== active).map((row) => row.toolCallId);
    instances.push({ key, activeToolCallId: active.toolCallId, supersededToolCallIds: superseded });
    for (const row of group) {
      byToolCallId[row.toolCallId] = {
        key,
        superseded: superseded.includes(row.toolCallId),
        autoExpand: recentTurns.includes(row.turnId),
        forcedInline: row.display?.kind === "mcp_tool" && row.display.ui?.showInline === true,
      };
    }
  }
  return { instances, byToolCallId };
}

/**
 * 纯函数：从投影行推导逻辑 UI 实例与每行的展示裁决（V-a）。
 * key 同时绑定来源、server、资源、权限与逻辑视图；同 key 内最新一次成功结果替代更早的成功结果，
 * running / failed / isError 的行既不替代别人也不被替代（各自显示自己的状态）。
 * autoExpand 按全部行的回合顺序取最近 N 个回合（回合里没有插件卡片也算一个回合）。
 *
 * 结果只依赖「回合首次出现顺序 + 插件 UI 行引用」，因此流式正文/普通工具更新时复用上一份结果：
 * 调用方（ConversationTimeline）把返回值继续当作 pin resolver 的输入，稳定引用才能让历史
 * turn 的派生缓存命中。缓存只保留最近一次输入，不延长历史窗口生命期。
 */
export function deriveLogicalUiInstances(
  rows: readonly ConversationRow[],
  options: { autoExpandTurns?: number } = {},
): PluginUiInstanceDerivation {
  // domain 不用 Map / Set（模块边界约束），全部用数组与普通对象。
  const autoExpandTurns = options.autoExpandTurns ?? PLUGIN_UI_AUTO_EXPAND_TURNS;
  const turnOrder: string[] = [];
  const seenTurns: Record<string, true> = Object.create(null) as Record<string, true>;
  const pluginRows: ToolCallRow[] = [];
  for (const row of rows) {
    if (!seenTurns[row.turnId]) {
      seenTurns[row.turnId] = true;
      turnOrder.push(row.turnId);
    }
    if (isPluginUiToolRow(row)) pluginRows.push(row);
  }

  if (
    lastInputs !== null &&
    lastDerivation !== null &&
    lastInputs.autoExpandTurns === autoExpandTurns &&
    hasSameStrings(lastInputs.turnOrder, turnOrder) &&
    hasSameRows(lastInputs.pluginRows, pluginRows)
  ) {
    return lastDerivation;
  }

  const derivation = deriveFromInputs({ turnOrder, pluginRows, autoExpandTurns });
  lastInputs = { turnOrder, pluginRows, autoExpandTurns };
  lastDerivation = derivation;
  return derivation;
}
