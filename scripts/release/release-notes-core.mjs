// 发布说明的纯解析/校验逻辑（CLI 在 release-notes.mjs，自测在 scripts/test/release-tooling.test.mjs）。
//
// 口径（运营者 2026-11-17 定）：
// - 官网更新日志与 GitHub Release 页使用**同一份**用户口径文案，来源是本仓库 CHANGELOG.md；
// - 固定三段：新功能 / 问题修复 / 变更；顺序固定，缺段可省略；
// - 只写用户能感知的行为与收益，不写工程实现、内部组件、依赖升级、路径/命令标识与安全细节。

export const RELEASE_SECTIONS = ["新功能", "问题修复", "变更"];

/**
 * 口径生效（2026-11-17）之前的历史条目只保留原文，不再要求分段。新增版本不得加入这里。
 */
export const LEGACY_VERSIONS = new Set(["4.0.2"]);

export const GITHUB_REPO = "Ebonyhtx/nibi-client";

/** 发布说明里绝对不能出现的工程/安全词。全部按“独立词”匹配（大小写不敏感）。 */
export const FORBIDDEN_ENGLISH = [
  "agent",
  "ai",
  "api",
  "backend",
  "caddy",
  "chromium",
  "ci",
  "cli",
  "commit",
  "cookie",
  "csrf",
  "cve",
  "db",
  "docker",
  "electron",
  "endpoint",
  "frontend",
  "http",
  "https",
  "ipc",
  "json",
  "jwt",
  "kernel",
  "log",
  "md5",
  "node.js",
  "oauth",
  "oss",
  "pr",
  "refactor",
  "rpc",
  "rsa",
  "rust",
  "s3",
  "sdk",
  "sha",
  "sql",
  "sqlite",
  "ssrf",
  "stack trace",
  "tls",
  "token",
  "typescript",
  "websocket",
  "xss",
  "yaml",
];

/** 中文里的工程/安全词。按子串匹配。 */
export const FORBIDDEN_CHINESE = [
  "内核",
  "编译",
  "构建",
  "依赖",
  "仓库",
  "分支",
  "合并",
  "重构",
  "接口",
  "端点",
  "服务端",
  "后端",
  "前端",
  "数据库",
  "表结构",
  "迁移",
  "缓存",
  "序列化",
  "反序列化",
  "线程",
  "进程",
  "端口",
  "日志",
  "竞态",
  "死锁",
  "内存泄漏",
  "单元测试",
  "测试用例",
  "回归测试",
  "契约",
  "凭据",
  "凭证",
  "密钥",
  "证书",
  "加密",
  "解密",
  "哈希",
  "签名",
  "注入",
  "越权",
  "漏洞",
  "攻击",
  "脱敏",
  "鉴权",
  "令牌",
  "存储桶",
  "对象存储",
  "云端存储",
  "直传",
  "限流",
  "队列",
];

/** 允许出现在反引号里的内容：都是用户在界面上/终端里真会输入的产品命令与格式名。 */
export const ALLOWED_BACKTICKED = new Set([
  "nibi doctor",
  "nibi skills",
  "nibi commands",
  "nibi update --check",
  "npm install -g @nibi-studio/cli",
  // 历史发布说明出现过旧清单目录；保留以校验既有发布记录，不代表当前格式。
  ".nibi-plugin",
]);

/** 允许出现在正文里的链接主机（发布说明只链官网，不链仓库文件/工单）。 */
const ALLOWED_LINK_HOSTS = ["nibistudio.cn"];

const MAX_SUMMARY_CHARS = 160;
const MAX_BULLET_CHARS = 220;
const MIN_BULLET_CHARS = 6;
const MAX_BULLETS_PER_SECTION = 20;

const VERSION_HEADING_RE = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})$/u;
const SECTION_HEADING_RE = /^### (.+)$/u;

function lineLength(text) {
  return [...text].length;
}

function wordBoundaryPattern(word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // 拉丁词按前后非字母数字边界匹配；中文里夹英文（如“新版Rust内核”）也能命中。
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "iu");
}

const FORBIDDEN_ENGLISH_PATTERNS = FORBIDDEN_ENGLISH.map((word) => ({
  word,
  pattern: wordBoundaryPattern(word),
}));

/**
 * 把 CHANGELOG.md 解析成条目数组（新→旧）。
 * 只认 `## [x.y.z] - YYYY-MM-DD` 标题；标题之前的说明文字忽略。
 */
export function parseChangelog(text) {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const entries = [];
  let current = null;
  let currentSection = null;

  const pushSection = () => {
    if (current && currentSection) {
      current.sections.push(currentSection);
      currentSection = null;
    }
  };

  for (const line of lines) {
    const versionMatch = line.match(VERSION_HEADING_RE);
    if (versionMatch) {
      pushSection();
      if (current) entries.push(current);
      current = {
        version: versionMatch[1],
        date: versionMatch[2],
        summaryLines: [],
        sections: [],
      };
      continue;
    }
    if (!current) continue;

    if (line.startsWith("## ")) {
      // 兼容 `## [Unreleased]` 之类的非版本二级标题：结束当前条目。
      pushSection();
      entries.push(current);
      current = null;
      continue;
    }

    const sectionMatch = line.match(SECTION_HEADING_RE);
    if (sectionMatch) {
      pushSection();
      currentSection = { name: sectionMatch[1].trim(), bullets: [], line };
      continue;
    }

    if (currentSection) {
      const bullet = line.match(/^-\s+(.*)$/u);
      if (bullet) {
        currentSection.bullets.push(bullet[1].trim());
      } else if (line.trim() !== "" && !line.startsWith("  ")) {
        // 段内出现非 bullet 的正文：保留下来让校验报错，不静默吞掉。
        currentSection.bullets.push(`__invalid__:${line.trim()}`);
      }
      continue;
    }

    if (line.trim() !== "") current.summaryLines.push(line.trim());
  }

  pushSection();
  if (current) entries.push(current);

  return entries.map((entry) => ({
    version: entry.version,
    date: entry.date,
    summary: entry.summaryLines.join("\n").trim(),
    sections: entry.sections,
  }));
}

function collectEntryText(entry) {
  return [entry.summary, ...entry.sections.flatMap((section) => section.bullets)].join("\n");
}

function checkForbiddenContent(entry) {
  const violations = [];
  const text = collectEntryText(entry);
  // 允许的产品命令（如 `npm install -g @nibi-studio/cli`）在查术语前先剥掉，
  // 否则 “cli” 会被当成内部缩写命中。
  const prose = text.replace(/`([^`]+)`/gu, (whole, inner) =>
    ALLOWED_BACKTICKED.has(inner.trim()) ? "" : whole,
  );

  for (const { word, pattern } of FORBIDDEN_ENGLISH_PATTERNS) {
    if (pattern.test(prose)) {
      violations.push(`含工程/安全术语 “${word}”`);
    }
  }
  for (const word of FORBIDDEN_CHINESE) {
    if (prose.includes(word)) {
      violations.push(`含工程/安全术语 “${word}”`);
    }
  }

  for (const match of text.matchAll(/`([^`]+)`/gu)) {
    if (!ALLOWED_BACKTICKED.has(match[1].trim())) {
      violations.push(`反引号内容 “${match[1]}” 不是允许的产品命令`);
    }
  }

  for (const match of text.matchAll(/\b\d+\.\d+\.\d+\b/gu)) {
    if (match[0] !== entry.version) {
      violations.push(`出现其它版本号 “${match[0]}”`);
    }
  }

  for (const match of text.matchAll(/https?:\/\/[^\s)]+/gu)) {
    const host = match[0].replace(/^https?:\/\//u, "").split("/")[0];
    if (!ALLOWED_LINK_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
      violations.push(`链接 ${match[0]} 不在允许域名内`);
    }
  }

  if (/\b[\w-]+\.(?:ts|tsx|js|mjs|cjs|rs|json|ya?ml|toml|exe|dll|so|db|log)\b/iu.test(text)) {
    violations.push("出现文件名或源码路径");
  }
  if (/```|!\[|\|.*\|/u.test(text)) {
    violations.push("出现代码块、图片或表格");
  }

  return violations;
}

/**
 * 校验单个条目。返回违规字符串数组；空数组即通过。
 */
export function validateEntry(entry) {
  const violations = [];
  const prefix = `${entry.version}`;

  if (LEGACY_VERSIONS.has(entry.version)) {
    if (!entry.summary) violations.push(`${prefix}: 缺少一句话概述`);
    return violations;
  }

  if (!entry.summary) {
    violations.push(`${prefix}: 缺少一句话概述`);
  } else {
    if (lineLength(entry.summary) > MAX_SUMMARY_CHARS) {
      violations.push(`${prefix}: 概述超过 ${MAX_SUMMARY_CHARS} 字`);
    }
    if (entry.summary.includes("\n")) {
      violations.push(`${prefix}: 概述必须是单独一段`);
    }
  }

  if (entry.sections.length === 0) {
    violations.push(`${prefix}: 至少需要一个 “新功能 / 问题修复 / 变更” 段`);
  }

  let lastOrder = -1;
  const seen = new Set();
  for (const section of entry.sections) {
    const order = RELEASE_SECTIONS.indexOf(section.name);
    if (order === -1) {
      violations.push(`${prefix}: 不允许的段落 “${section.name}”`);
      continue;
    }
    if (seen.has(section.name)) {
      violations.push(`${prefix}: 段落 “${section.name}” 重复`);
    }
    seen.add(section.name);
    if (order <= lastOrder) {
      violations.push(`${prefix}: 段落顺序必须是 新功能 → 问题修复 → 变更`);
    }
    lastOrder = Math.max(lastOrder, order);

    if (section.bullets.length === 0) {
      violations.push(`${prefix}: 段落 “${section.name}” 没有条目`);
    }
    if (section.bullets.length > MAX_BULLETS_PER_SECTION) {
      violations.push(`${prefix}: 段落 “${section.name}” 超过 ${MAX_BULLETS_PER_SECTION} 条`);
    }
    for (const bullet of section.bullets) {
      if (bullet.startsWith("__invalid__:")) {
        violations.push(`${prefix}: “${section.name}” 里出现了非列表正文`);
        continue;
      }
      const length = lineLength(bullet);
      if (length < MIN_BULLET_CHARS) {
        violations.push(`${prefix}: 条目过短 “${bullet}”`);
      }
      if (length > MAX_BULLET_CHARS) {
        violations.push(`${prefix}: 条目超过 ${MAX_BULLET_CHARS} 字 “${bullet.slice(0, 24)}…”`);
      }
    }
  }

  violations.push(...checkForbiddenContent(entry));
  return violations;
}

/**
 * 校验整份 CHANGELOG：条目结构、版本顺序、当前版本是否在顶部。
 */
export function validateChangelog(text, options = {}) {
  const entries = parseChangelog(text);
  const violations = [];

  if (entries.length === 0) {
    return { entries, violations: ["CHANGELOG.md 里没有任何版本条目"] };
  }

  const versions = new Set();
  let previous = null;
  for (const entry of entries) {
    if (versions.has(entry.version)) {
      violations.push(`${entry.version}: 版本重复`);
    }
    versions.add(entry.version);
    if (previous !== null && !isNewer(previous, entry.version)) {
      violations.push(`${entry.version}: 条目必须按版本从新到旧排列`);
    }
    previous = entry.version;
    violations.push(...validateEntry(entry));
  }

  if (options.currentVersion) {
    const top = entries[0];
    if (top.version !== options.currentVersion) {
      violations.push(
        `顶部条目是 ${top.version}，package.json 是 ${options.currentVersion}；先写好本版发布说明再发版`,
      );
    }
  }
  if (options.version) {
    if (!entries.some((entry) => entry.version === options.version)) {
      violations.push(`CHANGELOG.md 里没有 ${options.version} 的条目`);
    }
  }

  return { entries, violations };
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (pa[index] !== pb[index]) return pa[index] - pb[index];
  }
  return 0;
}

function isNewer(a, b) {
  return compareVersions(a, b) > 0;
}

/**
 * GitHub Release 正文：用户口径正文 + 固定下载区。正文与官网更新日志同源。
 */
export function buildGithubReleaseBody(entry) {
  const lines = [entry.summary, ""];
  for (const section of entry.sections) {
    lines.push(`### ${section.name}`, "");
    for (const bullet of section.bullets) lines.push(`- ${bullet}`);
    lines.push("");
  }
  lines.push(
    "## 下载",
    "",
    "- 官网下载页：https://nibistudio.cn/download/",
    "- 命令行工具：npm install -g @nibi-studio/cli",
    "- 可用平台与版本以官网下载页为准。",
    "",
    "完整变更见仓库 CHANGELOG.md。",
    "",
  );
  return lines.join("\n");
}

/** 比较 GitHub 正文时忽略行尾空白与首尾空行；其余必须逐字一致。 */
export function normalizeReleaseBody(text) {
  return text
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/^\n+/u, "")
    .replace(/\n+$/u, "");
}

export function releaseTitle(version) {
  return `NIBI ${version}`;
}

export function releaseTag(version) {
  return `v${version}`;
}

/** 读取线上 GitHub Release（无鉴权，公开仓）。404 返回 null；其它错误重试后抛出。 */
export async function fetchGithubRelease(version, fetchImpl = fetch) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${releaseTag(version)}`;
  const headers = {
    accept: "application/vnd.github+json",
    "user-agent": "nibi-release-notes-gate",
  };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetchImpl(url, { headers });
    if (response.status === 404) return null;
    if (response.ok) return response.json();
    if (attempt === 3) {
      throw new Error(`读取 GitHub Release 失败：HTTP ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
  return null;
}