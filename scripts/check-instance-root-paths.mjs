/**
 * 判据：实例路径（CLI 配置 / 插件 cache / 设置目录）不许写死在用户主目录。
 *
 * 为什么：`<数据根>/cli/config.json` 记的是"**这个实例**装了哪些插件、开了哪些开关"。
 * 用 `homedir() + ".nibi/cli"` 拼它，隔离实例（桌面端 dev / e2e、换根部署）就会去读写
 * **另一个实例**的配置。这条缺陷实测撞过四次：
 *   1. `subagents/subagentStorage.ts`（2026-10-09：dev 里"插件装了、子智能体却不出现"）
 *   2. `skills/skillsService.ts`（2026-10-10："添加 → 创建插件"报插件创建器不可用，
 *      技能列表列出的是线上实例的插件）
 *   3. `commands/commandsService.ts`、`plugin-sync/pluginSyncService.ts`
 *   4. `desktop/src/main/mcpUserDirectory`（会**写**进另一个实例的 `mcp.servers`）
 * 正确写法是 `resolveZCodeStorageRoot()`（显式参数 → NIBI_STORAGE_DIR / NIBI_DATA_BASE_DIR /
 * NIBI_HOME → 配置里的 storage.dir → `~/.nibi`），设置目录用 `NIBI_SETTINGS_DIR` 覆盖。
 *
 * 用法：node scripts/check-instance-root-paths.mjs [repoRoot]
 * 退出码：0 = 干净；1 = 有命中（列出文件:行）。
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(process.argv[2] ?? join(HERE, ".."));

/** 命中即报的写法：home 目录下拼 `.nibi/cli`（CLI 配置）或 `.nibi/plugins` 这类实例路径。 */
const FORBIDDEN = [
  /resolveUserHomeDir\(\)[^)]*,\s*"\.nibi",\s*"cli"/,
  /homedir\(\)[^)]*,\s*"\.nibi",\s*"cli"/,
];

/** 允许的例外：写清理由，否则下一个人不知道该不该跟随。 */
const ALLOWED = [
  {
    // 反馈日志导出：收集的是"这台机器上的 CLI 日志/现场"，跨实例收集是它的功能而不是缺陷。
    path: "packages/desktop/src/main/exportLogs.ts",
    reason: "调试/反馈用的日志收集，按设计读本机 CLI 目录；与实例隔离无关。",
  },
];

const SCAN_ROOTS = ["packages", "apps"].map((segment) => join(REPO_ROOT, segment));
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", "out", "coverage"]);

async function* walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    if (entry.name.includes(".test.") || entry.name.includes(".spec.")) continue;
    yield fullPath;
  }
}

const allowedPaths = new Set(ALLOWED.map((entry) => join(REPO_ROOT, entry.path).replace(/\\/g, "/")));
const hits = [];
let scanned = 0;
for (const root of SCAN_ROOTS) {
  for await (const file of walk(root)) {
    const normalized = file.replace(/\\/g, "/");
    scanned += 1;
    if (allowedPaths.has(normalized)) continue;
    const text = await readFile(file, "utf8");
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) continue;
      if (FORBIDDEN.some((pattern) => pattern.test(line))) {
        hits.push(`${relative(REPO_ROOT, file).replace(/\\/g, "/")}:${index + 1}: ${line.trim()}`);
      }
    }
  }
}

if (hits.length > 0) {
  console.error(`✗ 实例路径写死在用户主目录（扫了 ${scanned} 个文件，命中 ${hits.length} 处）：`);
  for (const hit of hits) console.error(`   · ${hit}`);
  console.error("  正确写法：resolveZCodeStorageRoot()（services 层）或读 NIBI_STORAGE_DIR / NIBI_DATA_BASE_DIR / NIBI_HOME；设置目录用 NIBI_SETTINGS_DIR 覆盖（见 settingService.getSettingsDir）。");
  process.exit(1);
}
console.log(`✓ 实例路径判据通过（扫 ${scanned} 个文件，白名单 ${ALLOWED.length} 处：${ALLOWED.map((entry) => entry.path).join(", ")}）`);
