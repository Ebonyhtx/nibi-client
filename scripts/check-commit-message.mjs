/**
 * 提交信息首行门禁：约定式类型 + 摘要长度 + 禁止内部流程词。
 *
 * 用法：node scripts/check-commit-message.mjs <commit-message-file>
 * Git 的 commit-msg hook 会把消息文件路径作为第一个参数传入（husky 里是 "$1"）。
 * 退出码：0 = 通过；1 = 不合规或无法读取文件。
 */
import { readFile } from "node:fs/promises";

const TYPES = [
  "feat",
  "fix",
  "docs",
  "refactor",
  "test",
  "chore",
  "build",
  "ci",
  "perf",
  "style",
  "revert",
];
const CONVENTIONAL = new RegExp(`^(${TYPES.join("|")})(\\([^()\\s]+\\))?!?: (.+)$`, "u");
// Git 自动生成的合并、回退与 rebase 修补提交不要求符合约定式格式。
const BYPASS_PREFIXES = ["Merge ", "revert:", "fixup!", "squash!"];
const INTERNAL_MARKERS = [
  [/第\s*\d+\s*步/u, "第 N 步"],
  [/收口/u, "收口"],
  [/去品牌/u, "去品牌"],
  [/未发布/u, "未发布"],
  [/台账/u, "台账"],
  [/\bWIP\b/iu, "WIP"],
  [/临时/u, "临时"],
  [/占位/u, "占位"],
];
const MAX_SUMMARY_LENGTH = 72;

function fail(reason) {
  console.error(
    [
      `提交信息检查未通过：${reason}`,
      "",
      "格式：<type>(<scope>)!: <summary>（scope 和 ! 可选）",
      `要求：英文祈使句，摘要不超过 ${MAX_SUMMARY_LENGTH} 个字符，不写步骤、收口、台账等内部流程词。`,
      "",
      "好：feat(desktop): add workspace switcher",
      "坏：fix: 第 3 步 收口插件商店",
      "",
      "详见 CONTRIBUTING.md 的「Commit messages」。",
    ].join("\n"),
  );
  process.exit(1);
}

const messageFile = process.argv[2];
if (!messageFile) {
  console.error("用法：node scripts/check-commit-message.mjs <commit-message-file>");
  process.exit(1);
}

let message;
try {
  message = await readFile(messageFile, "utf8");
} catch (error) {
  console.error(`无法读取提交信息文件：${messageFile}`);
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const [rawFirstLine = ""] = message.split(/\r?\n/u);
const line = rawFirstLine.replace(/\s+$/u, "");

if (BYPASS_PREFIXES.some((prefix) => line.startsWith(prefix))) {
  process.exit(0);
}

const match = CONVENTIONAL.exec(line);
if (!match) {
  fail("首行不是「类型(scope)!: 摘要」格式，或类型不在允许列表内");
}

const summary = match[3].trim();
if (!summary) {
  fail("摘要不能为空");
}

const foundMarkers = INTERNAL_MARKERS.filter(([pattern]) => pattern.test(summary)).map(
  ([, label]) => label,
);
if (foundMarkers.length > 0) {
  fail(`摘要包含内部流程词：${foundMarkers.join("、")}`);
}

const summaryLength = [...summary].length;
if (summaryLength > MAX_SUMMARY_LENGTH) {
  fail(`摘要 ${summaryLength} 个字符，超过 ${MAX_SUMMARY_LENGTH} 字符上限`);
}
