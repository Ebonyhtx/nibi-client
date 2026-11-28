import type { Event } from "@nibi/rpc";
import type { FileWatchEvent } from "@nibi/shared";
import { ServiceChannels } from "@nibi/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 文件系统监视服务
 *
 * 按路径粒度管理 watcher 实例。UI 展开目录时调用非递归 watch()，
 * Git 这类工作区级状态可调用递归 watch()。事件通过 onDynamicChange 以 RPC event 流式传输。
 */
export interface IFileWatcherService {
  /** 开始监视路径。返回 watcherId，用于 unwatch 和事件订阅 */
  watch(params: { path: string; recursive?: boolean }): Promise<{ id: string }>;
  /** 停止监视。释放 watcher 和相关资源 */
  unwatch(params: { id: string }): Promise<void>;
  /** 停止全部监视。host 退出清理时用于统一释放底层 fs.watch 句柄 */
  disposeAll(): void;
  /** 按 watcherId 订阅变更事件（onDynamic* 模式，RPC 自动路由） */
  onDynamicChange(id: string): Event<FileWatchEvent>;
}

export const IFileWatcherService = createServiceDescriptor<IFileWatcherService>(
  ServiceChannels.FileWatcher,
);

/**
 * 为单个 RPC 连接（MessagePort / WebSocket）包装文件监听器作用域：
 * 记录本连接通过 `watch` 创建的 ID，`unwatch` 时移除；连接断开调用 `disposeScope()` 自动补 `unwatch`。
 */
export function createConnectionScopedFileWatcherService(service: IFileWatcherService): {
  service: IFileWatcherService;
  disposeScope: () => Promise<void>;
} {
  const ownedIds = new Set<string>();
  let disposed = false;
  const scoped = new Proxy(service, {
    get(target, prop, receiver) {
      if (prop === "watch") {
        return async (params: { path: string; recursive?: boolean }) => {
          const result = await target.watch(params);
          if (disposed) {
            await target.unwatch({ id: result.id }).catch(() => {});
            return result;
          }
          ownedIds.add(result.id);
          return result;
        };
      }
      if (prop === "unwatch") {
        return async (params: { id: string }) => {
          ownedIds.delete(params.id);
          await target.unwatch(params);
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
      await Promise.all(ids.map((id) => service.unwatch({ id }).catch(() => {})));
    },
  };
}
