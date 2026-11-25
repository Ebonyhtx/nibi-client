/**
 * 插件撤销列表（计划 C §7.4）。
 *
 * 为什么要有独立于市场清单的第二份名单：清单只回答「现在能装什么」，无法表达
 * 「已经装上的某个版本必须立刻停用」。安全事件里最需要的是后者——已安装用户不会
 * 因为市场下架而自动失去保护。撤销列表按 `pluginId`（可选版本区间 / 包 sha256）精确
 * block 或 warn，检查点在安装、更新、启动、代码激活。
 *
 * 与市场清单共用同一条内容签名链（detached `.sig`、Ed25519、`<kid>:<hex>` 轮换），
 * 但落盘位置独立：`<storageRoot>/plugin-revocations.json` + `.sig`。撤销是不可被用户
 * 覆盖的安全决定，因此只认签名主机 `dl.nibistudio.cn`，不接受用户自加来源。
 *
 * 失败语义（可用性优先、但绝不回退到更旧的名单）：
 * - 本地快照缺失/损坏/验签不过 → 按「无撤销」处理（离线可用）；下一次成功刷新修复。
 * - 刷新失败（网络、验签、解析、revision 倒退）→ 保留上一份成功快照。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyNibiContentSignature, type NibiContentSignatureVerifyOptions } from "@nibi/shared/node";
import { writeFileAtomically } from "./atomic-directory.js";
import { isRecord } from "./helpers.js";
import { matchesPluginVersionRanges } from "./version-compare.js";

/**
 * 撤销列表唯一来源：与市场清单**同目录**（`/plugins/`）。
 *
 * 这一条不能凭感觉写：发布脚本把 `content/plugins/*` 映射到分发端的 `/plugins/*`
 * （`content-publish.py` 的 `verify_distribution` 按 `root/plugins/<name>` 对账），
 * 市场清单同样是 `/plugins/marketplace.json`。撤销名单若放到桶根，发布链与客户端
 * 就会各说各话——名单永远 404，门禁等于没装。
 */
export const PLUGIN_REVOCATIONS_URL =
  "https://dl.nibistudio.cn/plugins/plugin-revocations.json";
export const PLUGIN_REVOCATIONS_FILE = "plugin-revocations.json";
export const PLUGIN_REVOCATIONS_SIGNATURE_FILE = `${PLUGIN_REVOCATIONS_FILE}.sig`;
/** 本机时钟超前发布链一天以上视为异常快照，不落盘（见 assertIssuedAtSane）。 */
export const PLUGIN_REVOCATIONS_MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;
/**
 * 30s 与市场清单刷新同口径：撤销列表是 KB 级 JSON，慢速代理下也够用；
 * 不设超时会让离线/坏代理下的刷新永久挂起。
 */
export const PLUGIN_REVOCATIONS_FETCH_TIMEOUT_MS = 30_000;
/**
 * 后台自动刷新的节流窗口：撤销列表是安全决定，但本地快照始终可读。
 * 24h 是「不点检查更新的用户也能在一天内拿到新名单」与「离线用户每次启动都白跑一次
 * 网络、拖慢启动并刷日志」之间的折中；可用 TTL 注入覆盖（测试/特殊宿主）。
 */
export const PLUGIN_REVOCATIONS_REFRESH_TTL_MS = 24 * 60 * 60 * 1000;
/** 刷新尝试记录（只记时间，不记结果——失败也要节流，避免每次启动重试风暴）。 */
export const PLUGIN_REVOCATIONS_REFRESH_META_FILE = "plugin-revocations.meta.json";
/** `off`/`0`/`false` 关闭后台刷新；`force` 忽略 TTL（排障用）。大小写不敏感。 */
export const PLUGIN_REVOCATIONS_REFRESH_ENV = "NIBI_PLUGIN_REVOCATIONS_REFRESH";

export type PluginRevocationAction = "block" | "warn";

export interface PluginRevocationEntry {
  /** `<name>@<marketplace>`，与安装记录/consent 用同一个稳定 id。 */
  pluginId: string;
  /**
   * 版本约束列表，语法见 `matchesPluginVersionRanges`：精确版本或 `<1.2.3` / `<=` / `>` / `>=`。
   * 缺省表示该插件所有版本。
   */
  versions?: string[];
  /** 包内容 sha256（64 hex，大小写不敏感）。缺省表示不按内容限定。 */
  sha256?: string;
  reason?: string;
  /** 缺省按 `block`：写错的条目宁可多拦，不能默认放行。 */
  action: PluginRevocationAction;
}

export interface PluginRevocationDocument {
  /** 单调递增；倒退即拒绝（否则重放旧名单等于撤销掉本次撤销）。 */
  revision: number;
  issuedAt: string;
  entries: PluginRevocationEntry[];
}

export interface PluginRevocationMatch {
  action: PluginRevocationAction;
  entry: PluginRevocationEntry;
  pluginId: string;
  reason?: string;
}

export interface RefreshPluginRevocationsInput {
  storageRoot: string;
  /** 注入点：测试用假 fetch；缺省全局 fetch。 */
  fetchImpl?: typeof fetch;
  now?: Date;
  signal?: AbortSignal;
  /** 验签覆盖（测试/轮换）；缺省内置公钥表。 */
  verify?: NibiContentSignatureVerifyOptions;
}

export interface RefreshPluginRevocationsResult {
  status: "updated" | "unchanged";
  document: PluginRevocationDocument;
}

/** 后台刷新尝试记录。只有时间戳：失败也写，用于节流而不是记录结果。 */
export interface PluginRevocationsRefreshMeta {
  lastAttemptAt: string;
}

export interface MaybeRefreshPluginRevocationsInput {
  storageRoot: string;
  /** 环境变量来源；缺省 `process.env`（宿主可注入隔离环境）。 */
  env?: Record<string, string | undefined>;
  /** 覆盖 {@link PLUGIN_REVOCATIONS_REFRESH_TTL_MS}。0 表示不节流。 */
  ttlMs?: number;
  /** 注入时钟：TTL 判定与写入 meta 用同一时刻，测试可复现。 */
  now?: Date;
  /** 注入点：测试用假 fetch；缺省全局 fetch。 */
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** 忽略 TTL 立即尝试（排障用）；仍受 `off` 开关约束。 */
  force?: boolean;
  /** 验签覆盖（测试/轮换）；缺省内置公钥表。 */
  verify?: NibiContentSignatureVerifyOptions;
}

export interface MaybeRefreshPluginRevocationsResult {
  status: "skipped" | "updated" | "unchanged" | "failed";
  /** 仅 `failed` 填充：已归一化的错误文本（函数本身绝不抛出）。 */
  message?: string;
  /** 成功拿到文档时为其 revision；失败/跳过为 undefined。 */
  revision?: number;
}

const PLUGIN_ID_PATTERN = /^[^\s@]+@[^\s@]+$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function revocationsJsonPath(storageRoot: string): string {
  return join(storageRoot, PLUGIN_REVOCATIONS_FILE);
}

function revocationsSignaturePath(storageRoot: string): string {
  return join(storageRoot, PLUGIN_REVOCATIONS_SIGNATURE_FILE);
}

function refreshMetaPath(storageRoot: string): string {
  return join(storageRoot, PLUGIN_REVOCATIONS_REFRESH_META_FILE);
}

/**
 * 严格解析：任一 entry 结构不合法就整份文档作废。
 *
 * 不能「丢掉坏条目继续用」——撤销名单是安全决定，静默丢弃一条 block 条目就等于
 * 放行被撤销的插件。作废后调用方保留上一份成功快照，刷新失败可见。
 */
export function parsePluginRevocations(value: unknown): PluginRevocationDocument | null {
  if (!isRecord(value)) return null;
  const revision = value.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 0) return null;
  const issuedAt = typeof value.issuedAt === "string" ? value.issuedAt.trim() : "";
  if (!issuedAt || !Number.isFinite(Date.parse(issuedAt))) return null;
  if (!Array.isArray(value.entries)) return null;
  const entries: PluginRevocationEntry[] = [];
  for (const raw of value.entries) {
    const entry = parseEntry(raw);
    if (!entry) return null;
    entries.push(entry);
  }
  return { entries, issuedAt, revision };
}

function parseEntry(raw: unknown): PluginRevocationEntry | null {
  if (!isRecord(raw)) return null;
  const pluginId = typeof raw.pluginId === "string" ? raw.pluginId.trim() : "";
  if (!PLUGIN_ID_PATTERN.test(pluginId)) return null;
  const versions = parseEntryVersions(raw.versions);
  if (versions === null) return null;
  let sha256: string | undefined;
  if (raw.sha256 !== undefined) {
    if (typeof raw.sha256 !== "string") return null;
    const normalized = raw.sha256.trim().toLowerCase();
    if (!SHA256_PATTERN.test(normalized)) return null;
    sha256 = normalized;
  }
  const action = raw.action === undefined ? "block" : raw.action;
  if (action !== "block" && action !== "warn") return null;
  const reason = typeof raw.reason === "string" && raw.reason.trim() ? raw.reason.trim() : undefined;
  return {
    action,
    pluginId,
    ...(reason ? { reason } : {}),
    ...(sha256 ? { sha256 } : {}),
    ...(versions ? { versions } : {}),
  };
}

/**
 * `versions` 可以是字符串或字符串数组；空数组视为无效（写清约束或整条省略）。
 * 缺省返回 `undefined`（合法：全版本），结构错误返回 `null`（整份文档作废）——
 * 两者必须区分，否则「不写版本」会被当成非法条目。
 */
function parseEntryVersions(raw: unknown): string[] | null | undefined {
  if (raw === undefined) return undefined;
  const list = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : null;
  if (!list || list.length === 0) return null;
  const versions: string[] = [];
  for (const item of list) {
    if (typeof item !== "string" || !item.trim()) return null;
    versions.push(item.trim());
  }
  return versions;
}

/**
 * 读本地快照。验签覆盖磁盘上的原始字节，因此必须与 `.sig` 成对读取：
 * 只有 JSON 没有签名 = 来历不明，按无撤销处理（不能凭本地文件扩大或缩小安全决定）。
 *
 * `verify` 只是测试/轮换注入点；生产路径用内置公钥表。
 */
export function readPluginRevocations(
  storageRoot: string,
  verify?: NibiContentSignatureVerifyOptions,
): PluginRevocationDocument | null {
  try {
    const body = readFileSync(revocationsJsonPath(storageRoot));
    const signature = readFileSync(revocationsSignaturePath(storageRoot), "utf8");
    if (!verifyNibiContentSignature(body, signature, verify)) return null;
    return parsePluginRevocations(JSON.parse(body.toString("utf8")) as unknown);
  } catch {
    return null;
  }
}

/**
 * 拉取并落盘撤销列表。
 *
 * 写盘用的是**下载到的原始字节**，不是重新序列化的对象——签名覆盖原始字节，
 * 重新序列化（字段顺序/空白）会让下一次读取验签失败。
 */
export async function refreshPluginRevocations(
  input: RefreshPluginRevocationsInput,
): Promise<RefreshPluginRevocationsResult> {
  const now = input.now ?? new Date();
  const [body, signatureBytes] = await Promise.all([
    fetchRevocationResource(input, PLUGIN_REVOCATIONS_URL),
    fetchRevocationResource(input, `${PLUGIN_REVOCATIONS_URL}.sig`, true),
  ]);
  // 签名 sidecar 是文本（裸 hex 或 `<kid>:<hex>`）；下载统一走字节，这里再解码。
  const signature = new TextDecoder().decode(signatureBytes);
  if (!verifyNibiContentSignature(body, signature, input.verify)) {
    throw new Error("Plugin revocation list signature verification failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new Error("Plugin revocation list is not valid JSON");
  }
  const document = parsePluginRevocations(parsed);
  if (!document) throw new Error("Plugin revocation list is malformed");
  const issuedAtMs = Date.parse(document.issuedAt);
  if (issuedAtMs > now.getTime() + PLUGIN_REVOCATIONS_MAX_CLOCK_SKEW_MS) {
    throw new Error(
      `Plugin revocation list issuedAt is in the future: ${document.issuedAt}`,
    );
  }
  const previous = readCurrentRevisionSync(input.storageRoot);
  if (previous !== undefined && document.revision < previous) {
    throw new Error(
      `Plugin revocation list revision went backwards: ${document.revision} < ${previous}`,
    );
  }
  if (previous === document.revision && isSameSnapshotSync(input.storageRoot, body, signature)) {
    return { document, status: "unchanged" };
  }
  // 顺序说明：先写签名再写 JSON。中途崩溃只会留下「新签名 + 旧 JSON」→ 验签失败
  // → 按无撤销处理；下一次刷新自愈。反过来会留下「新 JSON + 旧签名」，同样失败，
  // 但那样旧名单更早被覆盖，诊断时更难看出是撕裂写。
  await writeFileAtomically(revocationsSignaturePath(input.storageRoot), signature);
  await writeFileAtomically(revocationsJsonPath(input.storageRoot), body);
  return { document, status: "updated" };
}

/**
 * 读取上一次后台刷新尝试的时间。文件缺失/损坏/时间戳非法都返回 `null`——
 * 节流记录不是安全数据，坏了只会让下一次启动多试一次，不能反过来阻断刷新。
 */
export function readPluginRevocationsRefreshMeta(
  storageRoot: string,
): PluginRevocationsRefreshMeta | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(refreshMetaPath(storageRoot), "utf8"));
    if (!isRecord(raw)) return null;
    const lastAttemptAt = typeof raw.lastAttemptAt === "string" ? raw.lastAttemptAt.trim() : "";
    if (!lastAttemptAt || !Number.isFinite(Date.parse(lastAttemptAt))) return null;
    return { lastAttemptAt };
  } catch {
    return null;
  }
}

/**
 * 后台自动刷新撤销列表（启动时一次 fire-and-forget）。
 *
 * 背景：撤销列表原先只在用户主动点「检查更新」时刷新，从不点的人永远拿不到新名单，
 * 门禁形同虚设。这里按「尝试时间」做节流，而不是按成功时间：
 * - 离线用户每次启动都重试网络，会拖慢启动并刷日志；撤销列表读取的是本地签名快照，
 *   晚一天更新可以接受（失败期间旧快照仍然生效）。
 * - 因此无论成功失败都写 `lastAttemptAt`，下一次启动在 TTL 内直接跳过。
 *
 * 语义边界：
 * - `off`/`0`/`false` 连网络都不发；`force` 只绕过 TTL，不绕过 off。
 * - 任何失败都收敛成 `{ status: "failed", message }`，**不向调用方抛**——后台任务
 *   不能影响 App 启动。
 * - meta 写失败不影响返回值：它只是节流记录，写不进去最多下次再试一次。
 */
export async function maybeRefreshPluginRevocations(
  input: MaybeRefreshPluginRevocationsInput,
): Promise<MaybeRefreshPluginRevocationsResult> {
  const env = input.env ?? process.env;
  const flag = (env[PLUGIN_REVOCATIONS_REFRESH_ENV] ?? "").trim().toLowerCase();
  // 关闭开关优先于一切：显式关掉时连 TTL 记录都不读，更不产生真实外发请求。
  if (flag === "off" || flag === "0" || flag === "false") {
    return { status: "skipped" };
  }
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const ttlMs = input.ttlMs ?? PLUGIN_REVOCATIONS_REFRESH_TTL_MS;
  const force = input.force === true || flag === "force";
  if (!force) {
    const meta = readPluginRevocationsRefreshMeta(input.storageRoot);
    const lastAttemptMs = meta ? Date.parse(meta.lastAttemptAt) : Number.NaN;
    // 未来时间戳（时钟回拨或被手改）不能把刷新无限推后：当作无效记录重新尝试。
    if (
      Number.isFinite(lastAttemptMs) &&
      lastAttemptMs <= nowMs &&
      nowMs - lastAttemptMs < ttlMs
    ) {
      return { status: "skipped" };
    }
  }
  try {
    const result = await refreshPluginRevocations({
      now,
      storageRoot: input.storageRoot,
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.verify === undefined ? {} : { verify: input.verify }),
    });
    await recordRefreshAttempt(input.storageRoot, now);
    return { revision: result.document.revision, status: result.status };
  } catch (error) {
    // 先记录尝试时间再返回：失败路径同样要被节流，否则断网时每次启动都会重试。
    await recordRefreshAttempt(input.storageRoot, now);
    return {
      message: error instanceof Error ? error.message : String(error),
      status: "failed",
    };
  }
}

async function recordRefreshAttempt(storageRoot: string, now: Date): Promise<void> {
  const meta: PluginRevocationsRefreshMeta = { lastAttemptAt: now.toISOString() };
  try {
    await writeFileAtomically(refreshMetaPath(storageRoot), JSON.stringify(meta));
  } catch {
    // 元数据只是节流记录：写失败只会让下次启动再试一次，不能改变本次刷新的结果。
  }
}

/**
 * 只在「已接受 revision」可读时返回它。不能走 readPluginRevocations：
 * 那份快照可能因为撕裂写暂时验签失败，此时若当作「没有 revision」，
 * 回滚保护就消失了。
 */
function readCurrentRevisionSync(storageRoot: string): number | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(revocationsJsonPath(storageRoot), "utf8"),
    ) as unknown;
    if (!isRecord(raw)) return undefined;
    const revision = raw.revision;
    return typeof revision === "number" && Number.isInteger(revision) && revision >= 0
      ? revision
      : undefined;
  } catch {
    return undefined;
  }
}

function isSameSnapshotSync(storageRoot: string, body: Uint8Array, signature: string): boolean {
  try {
    return (
      Buffer.compare(readFileSync(revocationsJsonPath(storageRoot)), Buffer.from(body)) === 0 &&
      readFileSync(revocationsSignaturePath(storageRoot), "utf8").trim() === signature.trim()
    );
  } catch {
    return false;
  }
}

async function fetchRevocationResource(
  input: RefreshPluginRevocationsInput,
  url: string,
  asText = false,
): Promise<Uint8Array> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  input.signal?.throwIfAborted();
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("Plugin revocation list fetch timed out")),
    PLUGIN_REVOCATIONS_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetchImpl(url, {
      headers: { accept: asText ? "text/plain" : "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * 判定某个具体插件（可选版本/内容 hash）是否命中撤销条目。
 *
 * 语义要点：
 * - 只按 `pluginId` 精确匹配，不做名字前缀/子串匹配（撤销面不能因为命名相似而扩大）。
 * - 条目声明了 `versions` 但调用方给不出当前版本 → 不命中。硬判成命中会把同插件的
 *   其它正常版本一起拦下；调用方（安装/更新/启动）都拿得到真实版本。
 * - 条目声明了 `sha256` 但调用方给不出内容 hash → 不命中，同理。
 * - 同时命中多条时 `block` 优先（安全决定不能被更弱的 warn 覆盖）。
 */
export function evaluatePluginRevocation(input: {
  document: PluginRevocationDocument | null | undefined;
  pluginId: string;
  version?: string;
  sha256?: string;
}): PluginRevocationMatch | null {
  if (!input.document) return null;
  const pluginId = input.pluginId.trim();
  if (!pluginId) return null;
  const sha256 = input.sha256?.trim().toLowerCase();
  let warning: PluginRevocationMatch | null = null;
  for (const entry of input.document.entries) {
    if (entry.pluginId !== pluginId) continue;
    if (entry.versions && !matchesPluginVersionRanges(input.version, entry.versions)) continue;
    if (entry.sha256 !== undefined && entry.sha256 !== sha256) continue;
    const match: PluginRevocationMatch = {
      action: entry.action,
      entry,
      pluginId,
      ...(entry.reason ? { reason: entry.reason } : {}),
    };
    if (entry.action === "block") return match;
    warning ??= match;
  }
  return warning;
}

/** 读本地快照后判定；供发现层（同步路径）使用。`verify` 同 {@link readPluginRevocations}。 */
export function checkPluginRevocation(input: {
  storageRoot: string;
  pluginId: string;
  version?: string;
  sha256?: string;
  verify?: NibiContentSignatureVerifyOptions;
}): PluginRevocationMatch | null {
  return evaluatePluginRevocation({
    document: readPluginRevocations(input.storageRoot, input.verify),
    pluginId: input.pluginId,
    ...(input.version !== undefined ? { version: input.version } : {}),
    ...(input.sha256 !== undefined ? { sha256: input.sha256 } : {}),
  });
}
