/**
 * 判据：构建产物里不许再出现「实例身份」的旧名（阶段 1 / 步骤 1.4）。
 *
 * 背景：分家后 NIBI 与正式版 ZCode 必须互不污染。实现上分两层：
 *   L1（本判据守的）：**实例身份** —— 数据根 `~/.nibi`、环境变量 `NIBI_*`、CLI 名 `nibi`。
 *   L2（2026-10-22 已改完，本判据只留必须保留的别名）：IPC 通道 `nibi:*`、
 *       线协议字段 `nibi_type`、主 renderer 的 `window.nibi` 桥、`nibiBuiltin*` 属性、
 *       `config/provider/nibi-builtin.json`。插件 ABI 已统一为 `.nibi-plugin/`、
 *       `NIBI_*`、`window.nibi` 与 `com.nibistudio.nibi/`，旧名不再放行。
 *
 * 为什么必须扫**产物**而不是源码：源码干净不代表产物干净。esbuild/vite 会把
 * define 注入值、依赖包里的字面量、内联的第三方代码一起打进来；`skill` 文档、
 * 内置提示词、插件 manifest 也可能带着旧路径进去。只看源码的判据是假绿。
 *
 * 三类判据：
 *   1. `ZCODE_*` 环境变量与路径段 `.zcode`（原来的两条）；
 *   2. 第三方 CDN 域名（A1/A2）；
 *   3. 实例身份词：`X-ZCode-*` 请求头、`zcode-` kebab 的用户可见文件名/日志标签/进程名。
 *      这一类原先完全漏掉——`zcode-server.cjs`、`zcode-data-size`、`zcode-window-bounds`
 *      都过门禁。逐条枚举的理由见 [`FORBIDDEN_IDENTITY_TOKENS`]。
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
  { path: "apps/nibi-cli/packages/cli/dist", stamps: ["nibi.cjs"] },
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

/**
 * 实例身份词（`zcode-` kebab / `X-ZCode-` 头 / 用户可见文件名）。
 *
 * 为什么单列、且**逐条枚举**而不是写 `/zcode-/`：泛正则会同时命中大量合法名字——
 * 兼容用的插件包格式 `zcode-plugin`、移植过来的插件名（`nibi-guide` 等）。
 * 判据一旦产噪声就没人看，等于空转。
 * 所以这里只放「确属我们的实例身份、且当前源码里已经清干净」的词，
 * 每加一条都要先把它清掉，否则门禁立刻红。
 *
 * 尚未清完、因此暂不列入的（列在这里是为了别忘，不是因为可以接受）：
 *
 * - **源码目录名** 已改成 `packages/services/src/nibi-agent/`、`src/nibi-session/` 等，会出现在
 *   产物 sourcemap 的路径里，所以**不能**写泛化的 `nibi-agent` / `nibi-session`（会天天假红）；
 *   这里只钉方括号形式的日志作用域等运行时字面量。
 * - `/* zcode-workflow` 已保存工作流文件的元数据块标记：文件格式契约，改名要迁就存量文件。
 * - 日志正文里的 "ZCode agent …" 措辞：只影响日志文本，且 e2e 覆盖率工具按其中一条
 *   （`ZCode agent process exited`）切片，改名要同批改那处解析。
 */
const FORBIDDEN_IDENTITY_TOKENS = [
  { token: "X-ZCode-", reason: "请求头前缀（原来发往模型服务端与自家服务端做观测）" },
  { token: "x-zcode-", reason: "请求头前缀的小写形态" },
  { token: "zcode-data-size", reason: "遥测日志标签，运营看日志时可见" },
  { token: "zcode-window-bounds", reason: "进程名，任务管理器里可见" },
  { token: "zcode-error-", reason: "用户可见的导出文件名前缀" },
  { token: "zcode-save-file-", reason: "用户可见的保存文件名前缀" },
  // 远端执行器（现在叫 `nibi-server.cjs` / `nibi-server-<target>.tar.gz`）。
  // 不写泛化的 `zcode-server`：历史产物与兼容串里仍有零散命中，泛词会让判据天天假红；
  // 这里只钉运行时真会暴露的那几个具体名字。
  { token: "zcode-server.cjs", reason: "远端执行器的 bundle 文件名（部署到远端 ~/.nibi/server/）" },
  { token: "zcode-server.tar.gz", reason: "远端 bootstrap 归档名" },
  { token: "zcode-server-linux-", reason: "远端发布包名（linux-x64 / linux-arm64）" },
  { token: "zcode-server-darwin-", reason: "远端发布包名（darwin-x64 / darwin-arm64）" },
  { token: "zcode-server-win32-", reason: "远端发布包名（win32-*）" },
  { token: "zcode-server:http", reason: "远端执行器的日志前缀" },
  { token: "zcode-server:stdio", reason: "远端执行器的日志前缀" },
  // 2026-11-07 清掉的最后一批「值级」旧名。每条都是写进日志/工单/诊断的**字面量**，
  // 而不是路径或注释，所以登记进来不会误伤 sourcemap。
  { token: "[zcode-agent]", reason: "进程管理器的日志作用域前缀（现在 [nibi-agent]）" },
  { token: "[zcode-task-service]", reason: "任务服务日志前缀（现在 [nibi-task-service]）" },
  { token: "[zcode-session-service]", reason: "会话服务日志前缀（现在 [nibi-session-service]）" },
  { token: "[zcode-agent-deploy]", reason: "远端部署日志前缀（现在 [nibi-agent-deploy]）" },
  {
    token: "[zcode-process-exception]",
    reason: "子进程 stderr 结构化诊断帧前缀（现在 [nibi-process-exception]）",
  },
  {
    token: "[zcode-agent-lifecycle-reported]",
    reason: "生命周期日志标记，ARMS 崩溃遥测按它匹配（现在 [nibi-agent-lifecycle-reported]）",
  },
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
 * 构建会在源码树里**生成**文件（`apps/nibi-cli` 的 `dist-types/`、`scripts/browser-client.mjs`、
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
    found.push({ token: match[0], kind: "env" });
  }

  // 只认「路径段」形态的 .zcode：前后都不能是标识符字符。
  // 这样 meta.zcode / record.zcode（上游消息 _meta 的 JSON 命名空间）不会被当成残留。
  for (const match of line.matchAll(/(?<![\w.])\.zcode(?![-_\w])/g)) {
    found.push({ token: match[0], kind: "path" });
  }

  // A1/A2：第三方 CDN 域名（不带 ZCODE_ 前缀，身份规则抓不到）。
  for (const { host, reason } of FORBIDDEN_THIRD_PARTY_HOSTS) {
    if (line.includes(host)) {
      found.push({ token: host, kind: "third-party-cdn", reason });
    }
  }

  // 实例身份词：`ZCODE_*` 与路径段 `.zcode` 之外的那一类（kebab、请求头、文件名）。
  for (const { token, reason } of FORBIDDEN_IDENTITY_TOKENS) {
    if (line.includes(token)) {
      found.push({ token, kind: "identity", reason });
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
        // 预过滤必须把 A1/A2 的域名与身份词都算进来，否则含 `ZCODE_`/`.zcode` 之外的行
        // 会被直接跳过 —— 将来把域名换成别的上游 CDN 时判据会假绿。
        // （实测踩过：新加的 `X-ZCode-` 规则一开始就是这样被预过滤吞掉的，判据全绿但其实没查。）
        const interesting =
          line.includes("ZCODE_") ||
          line.includes(".zcode") ||
          FORBIDDEN_THIRD_PARTY_HOSTS.some(({ host }) => line.includes(host)) ||
          FORBIDDEN_IDENTITY_TOKENS.some(({ token }) => line.includes(token));
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


