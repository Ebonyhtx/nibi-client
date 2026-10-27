// 插件验收合同（`plugin.json` 的 `acceptance` 字段）。
//
// 背景：宿主的完成判定原本只有一条通用检查——「这个目标做完了吗」。插件无法声明
// 「什么算完成」，于是插件自己的阶段门禁、环境实测、页数核算、匿名检查全部落不了地。
// 这个文件定义那层声明式合同：插件写清每个阶段的通过条件，宿主负责执行与记账。
//
// 解析刻意不抛异常：合同坏掉时插件仍然可用（只是不再享受门禁），问题以 problems
// 冒泡到 diagnostics，而不是让整个插件加载失败。

export type PluginAcceptanceCheckKind = "command" | "evidence";

/** 宿主执行一条检查时能提供的占位符。命令里的 `{{name}}` 会被替换成对应值。 */
export type PluginAcceptanceVariables = Record<string, string>;

export interface PluginAcceptanceCheck {
  /** 声明的唯一 id，被 stage.gate.checks 引用。 */
  id: string;
  kind: PluginAcceptanceCheckKind;
  /** 使用的强制项：未过则目标不得判定完成。默认 true。 */
  required: boolean;
  /**
   * 检查无法执行（缺依赖、超时、崩溃）时是否闭合失败。
   * false（默认）＝沿用宿主的 fail-open：基础设施故障不该把已交付的目标卡死。
   * true＝插件承诺「缺证据就是没完成」，此时无法执行等同于未通过。
   */
  failClosed: boolean;
  /** kind=command：要执行的命令模板，支持 {{workspace}} / {{pluginRoot}} / {{pluginData}}。 */
  run?: string;
  /** kind=command：期望退出码，默认 0。 */
  expectExitCode?: number;
  /** kind=evidence：要求引用到的产物（artifactId / artifactSetSha256）。 */
  requires?: string[];
  /** 展示用标题，缺省时回退到 id。 */
  title?: string;
  /** 展示用说明：这条检查在防什么。 */
  note?: string;
}

export interface PluginAcceptanceStage {
  id: string;
  title?: string;
  gate: { checks: string[] };
}

/**
 * 合同生效条件。
 *
 * 为什么必须有这一层：插件可能被装在跟它毫无关系的会话里。若不加条件，凡是启用
 * 该插件的目录，每个目标（包括一句「你好」）都要被它的阶段门禁拦一遍。这里给出
 * 一条可声明、可解释、可测试的激活判据，而不是让宿主去猜「这个会话是不是在用它」。
 */
export interface PluginAcceptanceActivation {
  /**
   * 仅当工作区根下这个相对路径存在时合同生效。
   * 插件用它声明「本工作区正在跑我的工作流」，例如 `状态/工作流状态.json`。
   */
  workspacePathExists?: string;
}

export interface PluginAcceptanceContract {
  version: 1;
  /** 缺省＝始终生效（插件自己承担作用域责任）。 */
  activation?: PluginAcceptanceActivation;
  stages: PluginAcceptanceStage[];
  checks: PluginAcceptanceCheck[];
  /** 自由文本备注；插件用来记录合同的驱动来源，宿主不使用。 */
  note?: string;
}

export interface PluginAcceptanceParseResult {
  contract?: PluginAcceptanceContract;
  /** 致命问题：非空表示合同不可用，宿主不得按它执行门禁。 */
  problems: string[];
  /** 非致命提醒：合同仍可用，但强度低于作者可能预期。 */
  warnings: string[];
}

export function isPluginAcceptanceUsable(result: PluginAcceptanceParseResult): boolean {
  return result.problems.length === 0 && result.contract !== undefined;
}

export const PLUGIN_ACCEPTANCE_VERSION = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

const CHECK_KINDS = new Set<string>(["command", "evidence"]);

function parseCheck(
  value: unknown,
  index: number,
  problems: string[],
  warnings: string[],
): PluginAcceptanceCheck | null {
  if (!isRecord(value)) {
    problems.push(`checks[${index}] 不是对象`);
    return null;
  }
  const id = readTrimmed(value.id);
  if (!id) {
    problems.push(`checks[${index}] 缺少 id`);
    return null;
  }
  const kind = readTrimmed(value.kind);
  if (!kind || !CHECK_KINDS.has(kind)) {
    problems.push(`check "${id}" 的 kind 必须是 command 或 evidence`);
    return null;
  }

  const check: PluginAcceptanceCheck = {
    failClosed: readBoolean(value.failClosed, false),
    id,
    kind: kind as PluginAcceptanceCheckKind,
    required: readBoolean(value.required, true),
  };
  if (check.required && !check.failClosed) {
    // 不是错误，但值得记一笔：required 却 fail-open，实际强度低于作者预期。
    warnings.push(
      `check "${id}" 是必需项但 failClosed=false：检查无法执行时会被当作通过（宿主基础设施故障的既有语义）`,
    );
  }

  const run = readTrimmed(value.run);
  const expectExitCode = readExpectExitCode(value, id, problems);
  if (kind === "command") {
    if (!run) {
      problems.push(`check "${id}" 是 command 但没有 run`);
      return null;
    }
    check.run = run;
    check.expectExitCode = expectExitCode;
  } else {
    const requires = Array.isArray(value.requires)
      ? value.requires.map(readTrimmed).filter((item): item is string => item !== undefined)
      : [];
    if (requires.length === 0) {
      problems.push(`check "${id}" 是 evidence 但没有 requires`);
      return null;
    }
    check.requires = requires;
  }

  const title = readTrimmed(value.title);
  if (title) check.title = title;
  const note = readTrimmed(value.note);
  if (note) check.note = note;
  return check;
}

function readExpectExitCode(
  value: Record<string, unknown>,
  id: string,
  problems: string[],
): number {
  if (typeof value.expectExitCode === "number" && Number.isInteger(value.expectExitCode)) {
    return value.expectExitCode;
  }
  // 兼容写法：`"expect": "exit 0"`。只认这一种形式，免得长出一个没人实现的期望值 DSL。
  const expect = readTrimmed(value.expect);
  if (expect) {
    const match = /^exit\s+(-?\d+)$/.exec(expect);
    if (match?.[1]) return Number.parseInt(match[1], 10);
    problems.push(`check "${id}" 的 expect 只支持 "exit <code>" 形式，收到：${expect}`);
  }
  return 0;
}

function parseStage(value: unknown, index: number, problems: string[]): PluginAcceptanceStage | null {
  if (!isRecord(value)) {
    problems.push(`stages[${index}] 不是对象`);
    return null;
  }
  const id = readTrimmed(value.id);
  if (!id) {
    problems.push(`stages[${index}] 缺少 id`);
    return null;
  }
  const gate = isRecord(value.gate) ? value.gate : undefined;
  const rawChecks = gate && Array.isArray(gate.checks) ? gate.checks : [];
  const checks = rawChecks.map(readTrimmed).filter((item): item is string => item !== undefined);
  if (checks.length === 0) {
    problems.push(`stage "${id}" 没有 gate.checks`);
    return null;
  }
  const stage: PluginAcceptanceStage = { gate: { checks }, id };
  const title = readTrimmed(value.title);
  if (title) stage.title = title;
  return stage;
}

/**
 * 解析并校验 `manifest.acceptance`。
 *
 * 合同只要能解析出至少一个阶段就会返回；跨字段问题（引用不存在的 check、
 * 重复 id）记进 problems。**只要 problems 非空就不算有效合同**——调用方据此
 * 决定是「不启用门禁并报警」还是「静默降级」，这个判断不该藏在解析器里。
 */
export function parsePluginAcceptance(value: unknown): PluginAcceptanceParseResult {
  if (value === undefined || value === null) return { problems: [], warnings: [] };
  if (!isRecord(value)) {
    return { problems: ["acceptance 必须是对象"], warnings: [] };
  }
  const version = value.version;
  if (version !== undefined && version !== PLUGIN_ACCEPTANCE_VERSION) {
    return {
      problems: [`acceptance.version 不支持：${String(version)}（当前支持 1）`],
      warnings: [],
    };
  }

  const problems: string[] = [];
  const warnings: string[] = [];
  const checks: PluginAcceptanceCheck[] = [];
  const checkIds = new Set<string>();
  const rawChecks = Array.isArray(value.checks) ? value.checks : [];
  rawChecks.forEach((raw, index) => {
    const check = parseCheck(raw, index, problems, warnings);
    if (!check) return;
    if (checkIds.has(check.id)) {
      problems.push(`check id 重复：${check.id}`);
      return;
    }
    checkIds.add(check.id);
    checks.push(check);
  });

  const stages: PluginAcceptanceStage[] = [];
  const stageIds = new Set<string>();
  const rawStages = Array.isArray(value.stages) ? value.stages : [];
  rawStages.forEach((raw, index) => {
    const stage = parseStage(raw, index, problems);
    if (!stage) return;
    if (stageIds.has(stage.id)) {
      problems.push(`stage id 重复：${stage.id}`);
      return;
    }
    stageIds.add(stage.id);
    for (const checkId of stage.gate.checks) {
      if (!checkIds.has(checkId)) {
        problems.push(`stage "${stage.id}" 引用了未声明的 check：${checkId}`);
      }
    }
    stages.push(stage);
  });

  // 生效判据先解析：下面的作用域告警要判断"有没有 when"，不能等最后才算。
  const activation = parseActivation(value.when ?? value.activation, problems);
  if (stages.length === 0) problems.push("acceptance 至少要声明一个 stage");
  if (checks.length === 0) problems.push("acceptance 至少要声明一个 check");
  // 没有生效判据 + 有硬门禁 = 该插件所在的每个会话、每个目标都要过这些检查。
  // 对"只在特定工作流里才有意义"的检查（阶段门、环境门）这几乎肯定是写漏了。
  const hasFailClosed = checks.some((check) => check.required && check.failClosed);
  if (hasFailClosed && !activation) {
    warnings.push(
      "acceptance 声明了 failClosed 的必需检查，却没有 when 生效判据："
      + "该插件所在的每个会话、每个目标都会被这些检查拦住。"
      + "若这些检查只在特定工作流里有意义，请加 when.workspacePathExists 限定作用域",
    );
  }
  // 必需但没挂进任何 stage 的检查：宿主仍会按"前置条件"强制，但作者大概是想把它挂到某个阶段上。
  const referencedIds = new Set(stages.flatMap((stage) => stage.gate.checks));
  for (const check of checks) {
    if (check.required && !referencedIds.has(check.id)) {
      warnings.push(
        `check "${check.id}" 是必需项但没被任何 stage 引用：宿主会把它当前置条件强制，`
        + `若要挂在某个阶段上，请把它的 id 加进那个 stage 的 gate.checks`,
      );
    }
  }

  const contract: PluginAcceptanceContract = { checks, stages, version: PLUGIN_ACCEPTANCE_VERSION };
  if (activation) contract.activation = activation;
  const note = readTrimmed(value.note);
  if (note) contract.note = note;
  return { contract, problems, warnings };
}

/** `when` 是文档里给插件作者的写法，`activation` 是同义的规范化名字，两者都收。 */
function parseActivation(
  value: unknown,
  problems: string[],
): PluginAcceptanceActivation | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    problems.push("acceptance.when 必须是对象");
    return undefined;
  }
  const workspacePathExists = readTrimmed(value.workspacePathExists);
  if (!workspacePathExists) {
    problems.push("acceptance.when 目前只支持 workspacePathExists");
    return undefined;
  }
  const escape = describeWorkspaceRelativePathProblem(workspacePathExists);
  if (escape) {
    problems.push(`acceptance.when.workspacePathExists ${escape}`);
    return undefined;
  }
  return { workspacePathExists };
}

export function describeWorkspaceRelativePathProblem(value: string): string | undefined {
  if (/^[a-zA-Z]:/.test(value)) return "不能是绝对路径（含盘符）";
  if (value.startsWith("/") || value.startsWith("\\")) return "不能是绝对路径";
  const segments = value.split(/[\\/]+/);
  if (segments.includes("..")) return "不能包含 .. 段（会走出工作区）";
  if (segments.every((segment) => segment.length === 0)) return "不能是空路径";
  return undefined;
}

/** 把检查引用的 check id 全部展开成检查对象；未知 id 静默跳过（解析期已报警）。 */
export function acceptanceChecksForStage(
  contract: PluginAcceptanceContract,
  stageId: string,
): PluginAcceptanceCheck[] {
  const stage = contract.stages.find((item) => item.id === stageId);
  if (!stage) return [];
  return stage.gate.checks.flatMap((checkId) => {
    const check = contract.checks.find((item) => item.id === checkId);
    return check ? [check] : [];
  });
}

/**
 * 展开命令模板里的占位符。
 *
 * 未提供的变量保留原样而不是替换成空串：命令里出现 `{{workspace}}` 字面量时，
 * 失败信息能直接指向「宿主没给这个变量」，比悄悄变成空参好排查。
 */
export function expandAcceptanceTemplate(
  template: string,
  variables: PluginAcceptanceVariables,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    const value = variables[name];
    return value === undefined ? match : value;
  });
}

/** 合同里出现的全部占位符名字，供宿主校验自己是否提供了这些变量。 */
export function acceptanceTemplateVariables(contract: PluginAcceptanceContract): string[] {
  const names = new Set<string>();
  for (const check of contract.checks) {
    if (!check.run) continue;
    for (const match of check.run.matchAll(/\{\{(\w+)\}\}/g)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names].sort();
}
