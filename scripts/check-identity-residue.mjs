/**
 * 判据：构建产物里不许再出现「实例身份」的旧名（阶段 1 / 步骤 1.4）。
 *
 * 背景：分家后 NIBI 与正式版 ZCode 必须互不污染。实现上分两层：
 *   L1（本判据守的）：**实例身份** —— 数据根 `~/.nibi`、环境变量 `NIBI_*`、CLI 名 `nibi`。
 *   L2（2026-10-22 已改完，本判据只留必须保留的别名）：IPC 通道 `nibi:*`、
 *       线协议字段 `nibi_type`、主 renderer 的 `window.nibi` 桥、`nibiBuiltin*` 属性、
 *       `config/provider/nibi-builtin.json`。仍允许残留的只有三类外部契约：
 *       插件包格式 `.zcode-plugin/`、元数据键 `com.zcode/`、插件面板的 `window.zcode`
 *       别名（同一对象，见 ALLOWED_ZCODE_PATH 注释）。
 *
 * 为什么必须扫**产物**而不是源码：源码干净不代表产物干净。esbuild/vite 会把
 * define 注入值、依赖包里的字面量、内联的第三方代码一起打进来；`skill` 文档、
 * 内置提示词、插件 manifest 也可能带着旧路径进去。只看源码的判据是假绿。
 *
 * 允许清单写在下面，每条都要写清为什么不能改。新增白名单等于放宽判据，必须给理由。
 *
 * 用法：node scripts/check-identity-residue.mjs [repoRoot]
 * 退出码：0 = 干净；1 = 有命中（列出文件、行号、上下文）。
 */
import { execFile as execFileCallback } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCallback);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(process.argv[2] ?? join(HERE, ".."));

/**
 * 只扫会真正发到用户机器上的产物。
 *
 * `stamps` = 这次构建写下的"构建完成"标记（每次构建都会重写）。
 * 为什么不看"目录里最早的文件"（2026-10-22 实测推翻）：产物目录里有大量**原样拷贝**的
 * 静态资产（渲染进程的 material-icons、插件文档），拷贝保留了源文件的 mtime（2026-09-26），
 * 于是"有任何一个文件比源码旧"永远成立 → 判据恒判陈旧、永远空转。用构建标记判断
 * "构建是否发生在最后一次源码改动之后"才是真正要问的问题。
 */
const ARTIFACT_ROOTS = [
  { path: "apps/zcode-cli/packages/cli/dist", stamps: ["nibi.cjs"] },
  {
    path: "packages/desktop/out",
    stamps: [".main-build-ready", ".host-build-ready"],
  },
  {
    // 随桌面构建一起产出，没有自己的标记文件：用 agent bundle 作标记。
    path: "packages/desktop/bundled-agents",
    stamps: ["win32-x64/glm/nibi.cjs"],
  },
];

/**
 * 允许残留的 token：**插件包格式与线协议**，改了会断已发布插件或已上线协议。
 * 这是「向插件子进程输出别名」的唯一来源，宿主从不从这些旧名读配置。
 */
const ALLOWED_ZCODE_ENV = new Set([
  // 插件包格式的两个兼容常量：`.zcode-plugin/` 目录名与它的清单路径。
  // 已发布的第三方包仍用该目录，宿主必须能读；常量名带 ZCODE_ 只是因为它指的就是这个目录。
  "ZCODE_PLUGIN_MANIFEST_DIR",
  "ZCODE_MANIFEST_PATH",
  "ZCODE_MANIFEST_PATH2",
  "ZCODE_PLUGIN_ROOT",
  "ZCODE_PLUGIN_DATA",
  "ZCODE_PROJECT_DIR",
  "ZCODE_WORKSPACE_ROOT",
  "ZCODE_PLUGIN_ID",
  "ZCODE_CUA_PLUGIN_ROOT",
]);

/** 允许残留的 `.zcode*` 字面量：包格式、上游域名、深链 URL、插件桥别名。 */
const ALLOWED_ZCODE_PATH = [
  /\.zcode-plugin/, // 插件包格式目录，市场 zip 内结构
  /cdn\.zcode-ai\.com/, // 上游 CDN 域名，属外部契约
  /com\.zcode\//, // 元数据命名空间键
  // 插件面板的桥别名：宿主同时注入 window.nibi（主名）与 window.zcode（同一对象），
  // 只为已发布的第三方面板不失效；技能文档与我们自己的面板一律用 nibi。
  /window\.zcode/,
  // 深链 URL 的历史形态（nibi://oauth/...）。IPC 通道前缀已全部改为 nibi:，
  // 这里只放行 URL 形态，任何 `zcode:` 通道名都会重新被判据抓到。
  /"zcode:\/\//,
  /'zcode:\/\//,
];

/**
 * A1/A2（分家标准 §6）：**第三方 CDN 域名不得出现在产物里**。
 *
 * 为什么单列一份：`.zcode` 那套规则管的是"实例身份旧名"，这里管的是"我们把用户行为
 * 外发给谁"。上游在 remoteCdn.ts 里写死了 `cdn.codegeex.cn` / `cdn-zcode.z.ai` 作为
 * 下载源默认值，那是不带 `ZCODE_` 前缀、也不带 `.zcode` 路径段的纯域名，
 * 身份规则一条都抓不到。
 *
 * 例外只有模型服务商端点（`api.z.ai` / `chat.z.ai` / `bigmodel.cn`）——那是用户自己
 * 选的 provider，不是我们的基础设施，不在本判据范围。
 */
const FORBIDDEN_THIRD_PARTY_HOSTS = [
  { host: "cdn.codegeex.cn", reason: "上游（智谱系）CDN，不得作为我们的下载源" },
  { host: "cdn-zcode.z.ai", reason: "上游 CDN，不得作为我们的下载源" },
  { host: "cdn.zcode-ai.com", reason: "上游 CDN，不得作为我们的下载源" },
];


/** 扩展名白名单：产物里可能是 .cjs/.js/.mjs/.json，也可能有 sourcemap。 */
const TEXT_SUFFIX = /\.(cjs|mjs|js|json|map|txt|md|yml|yaml)$/i;

/**
 * 新鲜度判据：产物必须比「最近一次源码改动」新，否则扫到的是改名前的陈旧构建，
 * 报出来的"残留"全是假红。只比 apps 与 packages 下 src 目录的源码。
 *
 * 坑（实测踩过）：不能拿「整个产物目录的最新 mtime」对比源码——一个目录里只要有一个
 * 文件刚被写过（比如只重建了 main、没重建 host），整目录就会被判成新鲜，
 * 覆盖面里的旧产物照样混进来报假红。
 *
 * 2026-10-22 改口径：用**构建标记**判断新鲜度（见 ARTIFACT_ROOTS.stamps）。
 * 2026-10-22 再改口径：源码基线只认 **git 跟踪的文件**（`git ls-files`）。
 * 构建会在源码树里**生成**文件（`apps/zcode-cli` 的 `dist-types/`、`scripts/browser-client.mjs`、
 * node-repl-host 的桥接文件），它们比构建开始时刻更晚写出，会把基线一直往前推 →
 * 判据永远判陈旧、永远空转（实测：三次全量构建后仍是"陈旧"）。
 * 跟踪文件才是"源码改动"的语义来源；生成物归产物侧。
 */
const SOURCE_ROOTS = ["packages", "apps"];

async function newestSourceMtime() {
  const { stdout } = await execFile("git", ["ls-files", "-z", "--", ...SOURCE_ROOTS], {
    cwd: REPO_ROOT,
    maxBuffer: 32 * 1024 * 1024,
  });
  let newest = 0;
  for (const rel of stdout.split("\0")) {
    if (!rel) continue;
    if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(rel)) continue;
    // `dist-types/` 是构建产出的 .d.ts，虽然被跟踪但不是源码改动。
    if (rel.includes("/dist-types/")) continue;
    try {
      const info = await stat(join(REPO_ROOT, rel));
      if (info.mtimeMs > newest) newest = info.mtimeMs;
    } catch {
      // 并发删除：忽略
    }
  }
  return newest;
}

/**
 * 该产物根的构建时刻：所有标记文件都存在时取其中**最早**的一个（main/host 各自标记，
 * 只重建一半时取到的是旧的那个），缺一个就返回 null（判过期）。
 */
async function artifactBuildMtime(absoluteRoot, stamps) {
  let oldest = Number.POSITIVE_INFINITY;
  for (const stamp of stamps) {
    try {
      const info = await stat(join(absoluteRoot, stamp));
      if (info.mtimeMs < oldest) oldest = info.mtimeMs;
    } catch {
      return null;
    }
  }
  return Number.isFinite(oldest) ? oldest : null;
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // 产物目录不在（没构建过）：不报错，由调用方决定是否算失败
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (TEXT_SUFFIX.test(entry.name)) {
      yield path;
    }
  }
}

/** 收集一行里所有「不该出现」的旧名。 */
function findOffenders(line) {
  const found = [];

  for (const match of line.matchAll(/ZCODE_[A-Z0-9_]+/g)) {
    const token = match[0];
    if (!ALLOWED_ZCODE_ENV.has(token)) {
      found.push({ token, kind: "env" });
    }
  }

  // 只认「路径段」形态的 .zcode：前后都不能是标识符字符。
  // 这样 meta.zcode / record.zcode（上游消息 _meta 的 JSON 命名空间）不会被当成残留。
  for (const match of line.matchAll(/(?<![\w.])\.zcode(?![-_\w])/g)) {
    const token = match[0];
    if (ALLOWED_ZCODE_PATH.some((pattern) => pattern.test(line))) continue;
    found.push({ token, kind: "path" });
  }

  // A1/A2：第三方 CDN 域名（不带 ZCODE_ 前缀，身份规则抓不到）。
  for (const { host, reason } of FORBIDDEN_THIRD_PARTY_HOSTS) {
    if (line.includes(host)) {
      found.push({ token: host, kind: "third-party-cdn", reason });
    }
  }

  return found;
}

async function main() {
  const failures = [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  const missingRoots = [];
  const staleRoots = [];
  const newestSource = await newestSourceMtime();

  for (const entry of ARTIFACT_ROOTS) {
    const root = entry.path;
    const absolute = join(REPO_ROOT, root);
    let exists = true;
    try {
      await stat(absolute);
    } catch {
      exists = false;
    }
    if (!exists) {
      missingRoots.push(root);
      continue;
    }

    // 陈旧产物不能当判据输入：改名前的构建里必然满是旧名，报出来是假红。
    const buildTime = await artifactBuildMtime(absolute, entry.stamps);
    if (buildTime === null || (newestSource > 0 && buildTime < newestSource)) {
      staleRoots.push({
        root,
        artifact: buildTime === null ? "缺少构建标记" : new Date(buildTime).toISOString(),
        source: new Date(newestSource).toISOString(),
      });
      continue;
    }

    for await (const file of walk(absolute)) {
      let raw;
      try {
        raw = await readFile(file);
      } catch {
        continue;
      }
      // 跳过二进制（sourcemap 是文本，但 .node/.wasm 不是）。
      if (raw.subarray(0, 4096).includes(0)) continue;
      scannedFiles += 1;
      scannedBytes += raw.length;
      const text = raw.toString("utf8");
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        // 预过滤必须把 A1/A2 的域名也算进来，否则含 `ZCODE_`/`.zcode` 之外的行
        // 会被直接跳过 —— 将来把域名换成别的上游 CDN 时判据会假绿。
        const interesting =
          line.includes("ZCODE_") ||
          line.includes(".zcode") ||
          FORBIDDEN_THIRD_PARTY_HOSTS.some(({ host }) => line.includes(host));
        if (!interesting) continue;
        for (const offender of findOffenders(line)) {
          failures.push({
            file: relative(REPO_ROOT, file),
            line: index + 1,
            token: offender.token,
            kind: offender.kind,
            context: line.trim().slice(0, 200),
          });
        }
      }
    }
  }

  // 一个产物目录都没扫到 = 判据其实什么都没查，必须报出来而不是静默通过。
  if (missingRoots.length + staleRoots.length === ARTIFACT_ROOTS.length) {
    console.error("[identity-residue] 没有任何新鲜产物可扫。这不是通过，是判据空转。");
    for (const stale of staleRoots) {
      console.error("  陈旧：" + stale.root + "（产物 " + stale.artifact + " < 源码 " + stale.source + "）");
    }
    for (const missing of missingRoots) {
      console.error(`  缺失：${missing}`);
    }
    console.error("  先跑构建再跑本判据。");
    process.exit(1);
  }

  const counts = new Map();
  for (const hit of failures) {
    const key = `${hit.token} (${hit.kind})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  if (failures.length > 0) {
    console.error(
      `[identity-residue] 产物里仍有实例身份旧名：${failures.length} 处，${counts.size} 种。`,
    );
    for (const [token, count] of [...counts].sort((a, b) => b[1] - a[1])) {
      console.error(`  ${String(count).padStart(5)}  ${token}`);
    }
    console.error("");
    for (const hit of failures.slice(0, 40)) {
      console.error(`  ${hit.file}:${hit.line}`);
      console.error(`    ${hit.context}`);
    }
    if (failures.length > 40) {
      console.error(`  ...其余 ${failures.length - 40} 处省略`);
    }
    process.exit(1);
  }

  console.log(
    `[identity-residue] 通过：扫了 ${scannedFiles} 个产物文件、` +
      `${(scannedBytes / 1048576).toFixed(1)} MB，没有实例身份旧名。`,
  );
  if (missingRoots.length > 0) {
    console.log(`  未构建（已跳过）：${missingRoots.join("、")}`);
  }
  for (const stale of staleRoots) {
    console.log(`  陈旧（已跳过，需要重建）：${stale.root}`);
  }
}

await main();
