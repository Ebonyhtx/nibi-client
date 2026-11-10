import type {
  ConversationRow,
  SessionPhase,
  TurnHeaderRow,
} from "@nibi/shared/nibi-protocol-v4";
import type { PluginUiRowPinResolver } from "@/plugin-ui/index.js";
import type { BuildConversationTurnRenderUnitsOptions } from "@/v4/conversationTurnRenderUnitTypes.js";
import {
  materializeDraftUnit,
  normalizeRenderUnitPosition,
  resolveTurnRunning,
  shouldKeepRenderUnit,
  splitConversationTurnDrafts,
  type ConversationTurnRenderUnit,
} from "@/v4/conversationTurnRenderUnits.js";

/** 已完成 turn 的派生结果与 UI 时钟无关；缓存命中用它代替 nowMs 参与比较。 */
const CLOCK_INDEPENDENT: null = null;

interface CachedTurnUnit {
  unit: ConversationTurnRenderUnit;
  rows: readonly ConversationRow[];
  header: TurnHeaderRow | undefined;
  sessionPhase: SessionPhase | undefined;
  pinResolver: PluginUiRowPinResolver | undefined;
  clockMs: number | null;
}

function hasSameRows(previous: readonly ConversationRow[], next: readonly ConversationRow[]): boolean {
  if (previous.length !== next.length) {
    return false;
  }
  for (let index = 0; index < next.length; index += 1) {
    if (previous[index] !== next[index]) {
      return false;
    }
  }
  return true;
}

/**
 * turn 级派生缓存（渲染性能契约：docs/chat/message-render-performance.md）。
 *
 * 目标：流式帧只重建发生变化的那一轮，未变化的 turn 保持 render unit 的稳定引用，
 * 让 `ConversationTurnGroup` 的 memo 真正生效。
 *
 * - 已完成 turn 不接收逐秒变化的 `nowMs`：时钟只让「运行中」的轮次失效。
 * - 原始行（含隐藏行与 header 引用）、sessionPhase、插件固定裁决变化才让对应轮失效。
 * - 缓存只保留当前窗口的轮次；离开窗口的 turn 条目立即删除，不会成为第二份消息状态。
 *
 * 缓存只保存「materialized」结果，位置归一化（isLastTurn/默认展开）每次仍然按当前
 * 窗口重算，因此新轮追加时最后一轮的派生结果不会停留在旧位置。
 */
export class ConversationTurnRenderUnitCache {
  private readonly entries = new Map<string, CachedTurnUnit>();

  /** 当前缓存的 turn 数；用于断言窗口裁剪，不参与渲染。 */
  get size(): number {
    return this.entries.size;
  }

  has(turnKey: string): boolean {
    return this.entries.has(turnKey);
  }

  clear(): void {
    this.entries.clear();
  }

  build(
    rows: readonly ConversationRow[],
    options: BuildConversationTurnRenderUnitsOptions = {},
  ): ConversationTurnRenderUnit[] {
    const drafts = splitConversationTurnDrafts(rows);
    const materialized: ConversationTurnRenderUnit[] = [];
    const liveKeys = new Set<string>();

    for (let index = 0; index < drafts.length; index += 1) {
      const draft = drafts[index]!;
      liveKeys.add(draft.key);
      const cached = this.entries.get(draft.key);
      // 时钟只在运行轮参与比较；已完成轮的时长来自 header/segment 事实。
      const clockMs = resolveTurnRunning(draft, options)
        ? (options.nowMs ?? CLOCK_INDEPENDENT)
        : CLOCK_INDEPENDENT;
      if (
        cached &&
        cached.header === draft.header &&
        cached.sessionPhase === options.sessionPhase &&
        cached.pinResolver === options.pluginUiPinResolver &&
        cached.clockMs === clockMs &&
        hasSameRows(cached.rows, draft.orderedRows)
      ) {
        materialized.push(cached.unit);
        continue;
      }
      const unit = materializeDraftUnit(draft, index, drafts.length, options);
      this.entries.set(draft.key, {
        unit,
        rows: draft.orderedRows.slice(),
        header: draft.header,
        sessionPhase: options.sessionPhase,
        pinResolver: options.pluginUiPinResolver,
        clockMs,
      });
      materialized.push(unit);
    }

    for (const key of this.entries.keys()) {
      if (!liveKeys.has(key)) {
        this.entries.delete(key);
      }
    }

    const keptUnits = materialized.filter(shouldKeepRenderUnit);
    return keptUnits.map((unit, index) =>
      normalizeRenderUnitPosition(unit, index, keptUnits.length, options),
    );
  }
}
