import type { Event } from "@nibi/rpc";
import { ServiceChannels } from "@nibi/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type { TerminalFontFamilySource, TerminalThemeProfile } from "./terminalProfile.js";

export interface TerminalWindowsPtyInfo {
  backend: "conpty" | "winpty";
  buildNumber?: number;
}

export interface ITerminalService {
  create(params: { cols: number; rows: number; cwd?: string }): Promise<{
    id: string;
    shell: string;
    fontFamily: string;
    fontSize?: number;
    theme?: TerminalThemeProfile;
    fontFamilySource: TerminalFontFamilySource;
    windowsPty?: TerminalWindowsPtyInfo;
  }>;
  write(params: { id: string; data: string }): Promise<void>;
  resize(params: { id: string; cols: number; rows: number }): Promise<void>;
  dispose(params: { id: string }): Promise<void>;
  /** 启动时 cwd 位于 path 内的终端 id；受管 worktree 删除前的占用检查使用。 */
  listTerminalIdsUnderPath(params: { path: string }): Promise<string[]>;
  onDynamicData(id: string): Event<string>;
  onDynamicExit(id: string): Event<number>;
}

export const ITerminalService = createServiceDescriptor<ITerminalService>(ServiceChannels.Terminal);

/**
 * 为本地窗口 MessagePort 连接包装终端作用域：
 * 记录该渲染进程通过 `create` 申请的 PTY ID；仅在本地端口断连时自动释放残留 PTY。
 */
export function createConnectionScopedTerminalService(service: ITerminalService): {
  service: ITerminalService;
  disposeScope: () => Promise<void>;
} {
  const ownedIds = new Set<string>();
  let disposed = false;
  const scoped = new Proxy(service, {
    get(target, prop, receiver) {
      if (prop === "create") {
        return async (params: { cols: number; rows: number; cwd?: string }) => {
          const result = await target.create(params);
          if (disposed) {
            await target.dispose({ id: result.id }).catch(() => {});
            return result;
          }
          ownedIds.add(result.id);
          return result;
        };
      }
      if (prop === "dispose") {
        return async (params: { id: string }) => {
          ownedIds.delete(params.id);
          await target.dispose(params);
        };
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    service: scoped,
    async disposeScope() {
      if (disposed) return;
      disposed = true;
      const ids = Array.from(ownedIds);
      ownedIds.clear();
      await Promise.all(ids.map((id) => service.dispose({ id }).catch(() => {})));
    },
  };
}
