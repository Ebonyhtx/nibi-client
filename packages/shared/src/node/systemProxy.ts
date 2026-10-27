/**
 * 操作系统代理探测（Node 侧，无第三方依赖）。
 *
 * 为什么需要它：设置页的「HTTP 代理」留空时，很多用户其实**开着 Clash/v2ray 的系统代理**，
 * 只是没把端口填进客户端。旧行为是「留空 = 直连」，这些用户的所有外网功能都会失败，
 * 而内置浏览器却能用——同一个客户端两套出口，正是要收敛掉的分叉。
 *
 * 规则：设置页显式填写 > 操作系统代理 > 直连。本机回环与国内镜像另有隐式直连规则，
 * 不经过这里（见 egressProxy.ts）。
 *
 * 局限：PAC（AutoConfigURL）需要 JS 引擎，Node 侧无法求值；检测到 PAC 且没有固定
 * ProxyServer 时按“未配置”处理，并在返回值里标记 `source: "pac-unsupported"` 供诊断。
 */

import { execFileSync } from "node:child_process";

export interface SystemProxyDetection {
  url: string | null;
  source: "windows-registry" | "macos-scutil" | "linux-env" | "pac-unsupported" | "none";
}

const CACHE_MS = 30_000;
let cache: { at: number; value: SystemProxyDetection } | null = null;

function run(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

function normalize(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Windows：读 WinINET（与浏览器/系统设置同一份），`ProxyServer` 支持按协议分号列表。 */
export function parseWindowsProxyOutput(enableOutput: string, serverOutput: string): string | null {
  if (!/ProxyEnable\s+REG_DWORD\s+0x1/iu.test(enableOutput)) return null;
  const match = /ProxyServer\s+REG_SZ\s+(.+)/iu.exec(serverOutput);
  const raw = match?.[1]?.trim();
  if (!raw) return null;
  if (!raw.includes("=")) return normalize(raw);
  const entries = new Map<string, string>();
  for (const part of raw.split(";")) {
    const [scheme, value] = part.split("=");
    if (scheme && value) entries.set(scheme.trim().toLowerCase(), value.trim());
  }
  return normalize(entries.get("https") ?? entries.get("http"));
}

/** macOS：`scutil --proxy` 的文本输出。优先 HTTPS，其次 HTTP。 */
export function parseMacProxyOutput(output: string): string | null {
  const field = (name: string): string | null => {
    const match = new RegExp(`${name}\\s*:\\s*(.+)`, "u").exec(output);
    return match?.[1]?.trim() ?? null;
  };
  const enabled = (name: string): boolean => field(name) === "1";
  const httpsHost = field("HTTPSProxy");
  const httpsPort = field("HTTPSPort");
  const httpHost = field("HTTPProxy");
  const httpPort = field("HTTPPort");
  if (enabled("HTTPSEnable") && httpsHost) {
    return normalize(`${httpsHost}:${httpsPort ?? "443"}`);
  }
  if (enabled("HTTPEnable") && httpHost) {
    return normalize(`${httpHost}:${httpPort ?? "80"}`);
  }
  return null;
}

function detectWindows(): SystemProxyDetection {
  const base = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
  const enableOutput = run("reg", ["query", base, "/v", "ProxyEnable"]);
  const serverOutput = run("reg", ["query", base, "/v", "ProxyServer"]);
  if (enableOutput && serverOutput) {
    const url = parseWindowsProxyOutput(enableOutput, serverOutput);
    if (url) return { url, source: "windows-registry" };
  }
  const autoConfig = run("reg", ["query", base, "/v", "AutoConfigURL"]);
  if (autoConfig && /AutoConfigURL\s+REG_SZ\s+\S/iu.test(autoConfig)) {
    return { url: null, source: "pac-unsupported" };
  }
  return { url: null, source: "none" };
}

function detectMac(): SystemProxyDetection {
  const output = run("scutil", ["--proxy"]);
  const url = output ? parseMacProxyOutput(output) : null;
  return url ? { url, source: "macos-scutil" } : { url: null, source: "none" };
}

function detectLinux(): SystemProxyDetection {
  for (const key of ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "all_proxy", "ALL_PROXY"]) {
    const url = normalize(process.env[key]);
    if (url) return { url, source: "linux-env" };
  }
  return { url: null, source: "none" };
}

/** 同步探测（内部缓存 30s；失败/不支持时返回 none，绝不抛）。 */
export function detectSystemProxy(options: { force?: boolean } = {}): SystemProxyDetection {
  const now = Date.now();
  if (!options.force && cache && now - cache.at < CACHE_MS) return cache.value;
  let value: SystemProxyDetection;
  if (process.platform === "win32") value = detectWindows();
  else if (process.platform === "darwin") value = detectMac();
  else value = detectLinux();
  cache = { at: now, value };
  return value;
}

export async function resolveSystemProxyUrl(): Promise<string | null> {
  return detectSystemProxy().url;
}

/** 测试与诊断用：清掉缓存后重新探测。 */
export function clearSystemProxyCache(): void {
  cache = null;
}
