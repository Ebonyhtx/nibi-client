import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { realpath as fsRealpath, stat as fsStat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BROWSER_LOCAL_PREVIEW_SCHEME, type BrowserLocalPreviewResolveResult } from "@nibi/shared";
import type {
  BrowserLocalPreview,
  BrowserLocalPreviewDependencies,
  BrowserLocalPreviewFileFetcher,
  BrowserLocalPreviewPrivileges,
  BrowserLocalPreviewProtocolHost,
} from "./contract.js";

export type {
  BrowserLocalPreview,
  BrowserLocalPreviewDependencies,
  BrowserLocalPreviewFileFetcher,
  BrowserLocalPreviewPrivileges,
  BrowserLocalPreviewProtocolHost,
} from "./contract.js";

/**
 * 本地 HTML 预览的签名目录协议。
 *
 * file: 只作为输入：resolveNavigation 把「HTML 文件所在目录」作为根目录签名，换成
 * nibi-html://<hmac>/<encodedRoot>/<basename>；之后页面里的同目录资源请求都走 respond，
 * 每次都重新验签、重新 realpath，不在页面脚本和文件系统之间留下跨文件读取权限。
 */

/** 必须在 app ready 前与本地媒体预览 scheme 同一次 registerSchemesAsPrivileged 注册。 */
export const BROWSER_LOCAL_PREVIEW_PRIVILEGES: BrowserLocalPreviewPrivileges = {
  scheme: BROWSER_LOCAL_PREVIEW_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
};

function isContained(root: string, path: string): boolean {
  const child = relative(root, path);
  return (
    child !== "" && !isAbsolute(child) && child.split(sep).every((part) => !part.startsWith("."))
  );
}

export function createBrowserLocalPreview(
  dependencies: BrowserLocalPreviewDependencies = {},
): BrowserLocalPreview {
  const realpath = dependencies.realpath ?? fsRealpath;
  const isRegularFile =
    dependencies.isRegularFile ?? ((path: string) => fsStat(path).then((stats) => stats.isFile()));
  const fetchFile = dependencies.fetchFile;
  const createKey = dependencies.randomBytes ?? randomBytes;
  // 进程内共享签名密钥即可支持刷新和 guest 恢复，无需第二份持久化状态；
  // 完整退出后旧签名 URL 自然失效（恢复路径会重新解析 file:）。
  const key = createKey(32);
  const sign = (rootUrl: string) => createHmac("sha256", key).update(rootUrl).digest("hex");

  return {
    async resolveNavigation(input) {
      const source = new URL(input);
      if (source.protocol !== "file:") return input;
      // file://host/... 是 UNC/网络共享；本地预览只接受无 host 的本地路径。
      if (source.host || !/\.html?$/i.test(source.pathname)) {
        throw new Error("Only local HTML can be previewed");
      }
      const path = fileURLToPath(source);
      const root = await realpath(dirname(path));
      const file = await realpath(path);
      if (
        dirname(root) === root ||
        basename(root).startsWith(".") ||
        !isContained(root, file) ||
        !(await isRegularFile(file))
      ) {
        throw new Error("HTML is outside the preview directory");
      }
      const rootUrl = pathToFileURL(root + sep).href;
      // Windows junction 也可能把本地路径指向 UNC；解析后仍需拒绝网络共享授权。
      if (new URL(rootUrl).host) throw new Error("Network files cannot be previewed");
      const url = new URL(
        `${BROWSER_LOCAL_PREVIEW_SCHEME}://${sign(rootUrl)}/${encodeURIComponent(rootUrl)}/${encodeURIComponent(basename(path))}`,
      );
      url.search = source.search;
      url.hash = source.hash;
      return url.href;
    },

    async respond(request) {
      try {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return new Response(null, { status: 405 });
        }
        const url = new URL(request.url);
        const [, encodedRoot, ...encodedSegments] = url.pathname.split("/");
        const rootUrl = decodeURIComponent(encodedRoot ?? "");
        if (
          url.protocol !== `${BROWSER_LOCAL_PREVIEW_SCHEME}:` ||
          url.port ||
          url.username ||
          url.password ||
          !/^[a-f0-9]{64}$/.test(url.hostname) ||
          !timingSafeEqual(Buffer.from(url.hostname, "hex"), Buffer.from(sign(rootUrl), "hex"))
        ) {
          return new Response(null, { status: 403 });
        }
        const root = fileURLToPath(rootUrl);
        const canonicalRoot = await realpath(root);
        // 根目录必须就是签名时的真实路径；alias/大小写差异不能扩张授权范围。
        if (resolve(root) !== canonicalRoot) return new Response(null, { status: 403 });
        const segments = encodedSegments.map(decodeURIComponent);
        if (
          !segments.length ||
          segments.some(
            (part) => !part || part.startsWith(".") || part.includes("\0") || /[\\/:]/.test(part),
          )
        ) {
          return new Response(null, { status: 403 });
        }
        const file = await realpath(resolve(canonicalRoot, ...segments));
        if (!isContained(canonicalRoot, file)) return new Response(null, { status: 403 });
        if (!(await isRegularFile(file))) return new Response(null, { status: 404 });
        if (!fetchFile) throw new Error("Local preview file loader is not installed");
        // file 页面原有的跨文件权限不受 sandbox 限制；预览只把通过真实目录校验的资源交给 loader，
        // bypassCustomProtocolHandlers 避免再次进入本进程的 file handler 形成递归。
        const response = await fetchFile(pathToFileURL(file).href, request.method);
        const headers = new Headers(response.headers);
        headers.set("Cache-Control", "no-store");
        headers.set("X-Content-Type-Options", "nosniff");
        return new Response(response.body, { status: response.status, headers });
      } catch {
        return new Response(null, { status: 404 });
      }
    },
  };
}

let activePreview: BrowserLocalPreview | undefined;
let activeFetchFile: BrowserLocalPreviewFileFetcher | undefined;
const installedProtocols = new WeakSet<object>();

function getActivePreview(): BrowserLocalPreview {
  activePreview ??= createBrowserLocalPreview({
    fetchFile: (fileUrl, method) => {
      if (!activeFetchFile) throw new Error("Local preview file loader is not installed");
      return activeFetchFile(fileUrl, method);
    },
  });
  return activePreview;
}

/**
 * 导航入口与协议 handler 必须共用同一份签名密钥；这里返回进程内单例。
 * 未安装协议时也能完成 resolveNavigation（单测/其它宿主），但 respond 会 fail closed。
 */
export function resolveBrowserLocalPreviewNavigation(input: string): Promise<string> {
  return getActivePreview().resolveNavigation(input);
}

/**
 * Renderer IPC 入口：把信号/路径错误折成结构化结果，让 UI 能在浏览器面板里显示原因。
 * 仍复用同一份进程内签名实例；失败时绝不返回原始 file:。
 */
export async function resolveBrowserLocalPreviewUrl(
  input: string,
): Promise<BrowserLocalPreviewResolveResult> {
  try {
    return { success: true, url: await resolveBrowserLocalPreviewNavigation(input) };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * 只在内置浏览器的 partition session 上安装：
 * 1. 先用空错误 handler 封住原始 file 读面（即使后续安装失败也不会退回不受限 loader）；
 * 2. 再把 nibi-html 交给共享密钥的预览实例。
 */
export function installBrowserLocalPreview(
  browserSession: BrowserLocalPreviewProtocolHost,
  options: { fetchFile: BrowserLocalPreviewFileFetcher },
): void {
  const protocol = browserSession.protocol;
  if (installedProtocols.has(protocol)) return;
  installedProtocols.add(protocol);
  activeFetchFile = options.fetchFile;
  const preview = getActivePreview();
  protocol.handle("file", () => Response.error());
  protocol.handle(BROWSER_LOCAL_PREVIEW_SCHEME, (request) => preview.respond(request));
}
