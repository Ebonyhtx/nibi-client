import { useCallback, useState, type ReactNode } from "react";
import { useDataSyncDevices } from "@/data-sync/app/useDataSyncDevices.js";
import { useDataSyncSession } from "@/data-sync/app/useDataSyncSession.js";
import type { DataSyncDialogRequest } from "@/data-sync/contract.js";
import {
  DataSyncResultVersionContext,
  OpenDataSyncDialogContext,
} from "@/data-sync/ui/DataSyncDialogContext.js";
import { DataSyncDialog } from "@/data-sync/ui/DataSyncDialog.js";

interface DataSyncDialogState {
  request: DataSyncDialogRequest;
  minimized: boolean;
}

/**
 * 窗口级挂载：页面切换不能卸载推送 owner；最小化只改变显示状态。
 *
 * 单实例语义：已有弹窗时 `open` 只恢复，不替换 request——替换会丢失在途推送及其设备身份。
 */
export function DataSyncDialogProvider({ children }: { children: ReactNode }) {
  const [resultVersion, setResultVersion] = useState(0);
  const [current, setCurrent] = useState<DataSyncDialogState | null>(null);

  const open = useCallback((request: DataSyncDialogRequest) => {
    setCurrent((previous) =>
      previous ? { ...previous, minimized: false } : { request, minimized: false },
    );
  }, []);

  return (
    <OpenDataSyncDialogContext value={open}>
      <DataSyncResultVersionContext value={resultVersion}>
        {children}
        {current ? (
          <DataSyncSession
            request={current.request}
            minimized={current.minimized}
            onMinimizedChange={(minimized) =>
              setCurrent((previous) => (previous ? { ...previous, minimized } : null))
            }
            onClose={() => setCurrent(null)}
            onResultRecorded={() => setResultVersion((version) => version + 1)}
          />
        ) : null}
      </DataSyncResultVersionContext>
    </OpenDataSyncDialogContext>
  );
}

function DataSyncSession({
  request,
  minimized,
  onMinimizedChange,
  onClose,
  onResultRecorded,
}: {
  request: DataSyncDialogRequest;
  minimized: boolean;
  onMinimizedChange(minimized: boolean): void;
  onClose(): void;
  onResultRecorded(): void;
}) {
  // provider 只在用户打开同步后挂载本组件，因此设备列表与 attachment 都不会在启动时读取。
  const { devices } = useDataSyncDevices();
  const session = useDataSyncSession({
    devices,
    ...(request.category ? { initialCategory: request.category } : {}),
    ...(request.sourceServerId ? { initialDeviceId: request.sourceServerId } : {}),
    onPushFinished: onResultRecorded,
  });

  return (
    <DataSyncDialog
      open
      minimized={minimized}
      onMinimizedChange={onMinimizedChange}
      onClose={onClose}
      session={session}
    />
  );
}

export {
  useDataSyncResultVersion,
  useOpenDataSyncDialog,
} from "@/data-sync/ui/DataSyncDialogContext.js";
