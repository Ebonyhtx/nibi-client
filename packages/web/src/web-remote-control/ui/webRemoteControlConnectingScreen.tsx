import { CheckIcon, LoaderCircleIcon, PauseCircleIcon, RefreshCwIcon } from "lucide-react";
import { DevicePlatformIcon } from "@nibi/ui/device-platform-icon";
import { NibiWorkingIndicator } from "@nibi/ui/working-indicator";
import { WebRemoteControlBrand } from "#src/web-remote-control/ui/webRemoteControlBrand.js";
import type { WebRemoteControlScreenLocale } from "#src/web-remote-control/domain/webRemoteControlScreenCopy.js";
import type { WebRemoteControlTerminalTransportState } from "#src/web-remote-control/contract.js";

/** 连接过程页展示的目标电脑；名字来自连接参数，平台来自本机记住的设备记录。 */
export interface WebRemoteControlConnectingDevice {
  name?: string;
  platform?: string;
}

const copyByLocale = {
  "zh-CN": {
    connectingTo: (name: string) => `正在连接 ${name}`,
    connectingFallback: "正在连接电脑",
    steps: ["连接中转服务", "设备鉴权", "等待桌面端配对", "同步工作区"],
    stages: {
      connecting: "正在连接中转服务…",
      authenticating: "正在认证设备…",
      waiting: "等待桌面端确认配对…",
      paired: "已配对，正在加载工作区…",
      reconnecting: "连接中断，正在重连…",
      suspended: "页面在后台，等待恢复…",
      other: "正在准备远程控制…",
    },
    reconnectingDescription: "网络或休眠恢复后会自动重连，请稍候。",
    suspendedDescription: "回到前台后会自动恢复连接。",
  },
  "en-US": {
    connectingTo: (name: string) => `Connecting to ${name}`,
    connectingFallback: "Connecting to your computer",
    steps: [
      "Connect to relay service",
      "Authenticate device",
      "Wait for desktop pairing",
      "Sync workspace",
    ],
    stages: {
      connecting: "Connecting relay service…",
      authenticating: "Authenticating device…",
      waiting: "Waiting for desktop pairing…",
      paired: "Paired. Loading workspace…",
      reconnecting: "Connection interrupted, reconnecting…",
      suspended: "Page is in background, waiting to recover…",
      other: "Preparing remote control…",
    },
    reconnectingDescription: "Auto-reconnecting after network or wake-up changes.",
    suspendedDescription: "Connection will recover automatically when back in foreground.",
  },
};

// 线性阶段映射到 4 段进度；重连、后台等非线性状态不高亮任何一段。
const STEP_INDEX: Partial<Record<WebRemoteControlTerminalTransportState, number>> = {
  idle: 0,
  connecting: 0,
  authenticating: 1,
  waiting: 2,
  paired: 3,
};

function resolveStage(
  state: WebRemoteControlTerminalTransportState,
  copy: (typeof copyByLocale)["zh-CN"],
): { label: string; description?: string } {
  switch (state) {
    case "connecting":
    case "authenticating":
    case "waiting":
    case "paired":
      return { label: copy.stages[state] };
    case "reconnecting":
      return { label: copy.stages.reconnecting, description: copy.reconnectingDescription };
    case "suspended":
      return { label: copy.stages.suspended, description: copy.suspendedDescription };
    default:
      return { label: copy.stages.other };
  }
}

/** 选中设备到任务首页之间的全屏连接过程页；只呈现 transport 状态，不改变阶段逻辑。 */
export function WebRemoteControlLoadingScreen({
  state,
  locale,
  device,
}: {
  state: WebRemoteControlTerminalTransportState;
  locale: WebRemoteControlScreenLocale;
  device?: WebRemoteControlConnectingDevice;
}) {
  const copy = copyByLocale[locale];
  const stage = resolveStage(state, copy);
  const stepIndex = STEP_INDEX[state];
  const name = device?.name?.trim();
  const statusBadge =
    state === "paired" ? (
      <span
        aria-hidden="true"
        className="absolute -right-1.5 -bottom-1.5 flex size-6 items-center justify-center rounded-full border border-card bg-success text-success-foreground shadow-xs"
      >
        <CheckIcon className="size-3.5" />
      </span>
    ) : state === "reconnecting" ? (
      <span
        aria-hidden="true"
        className="absolute -right-1.5 -bottom-1.5 flex size-6 items-center justify-center rounded-full border border-card bg-warning text-warning-foreground shadow-xs"
      >
        <RefreshCwIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
      </span>
    ) : state === "suspended" ? (
      <span
        aria-hidden="true"
        className="absolute -right-1.5 -bottom-1.5 flex size-6 items-center justify-center rounded-full border border-card bg-surface text-foreground-subtle shadow-xs"
      >
        <PauseCircleIcon className="size-3.5" />
      </span>
    ) : (
      <span
        aria-hidden="true"
        className="absolute -right-1.5 -bottom-1.5 flex size-6 items-center justify-center rounded-full border border-card bg-primary text-primary-foreground shadow-xs"
      >
        <LoaderCircleIcon className="size-3.5 animate-spin motion-reduce:animate-none" />
      </span>
    );

  return (
    <div className="flex min-h-dvh w-full flex-col bg-sidebar pt-[calc(env(safe-area-inset-top)+12px)] pr-[max(1rem,env(safe-area-inset-right))] pb-[calc(env(safe-area-inset-bottom)+24px)] pl-[max(1rem,env(safe-area-inset-left))] text-foreground">
      <div className="mx-auto flex h-10 w-full max-w-md items-center">
        <WebRemoteControlBrand subtitle={locale === "zh-CN" ? "Web 远程控制" : "Web Remote"} />
      </div>
      <div className="flex flex-1 items-center justify-center py-6">
        <div
          role="status"
          aria-live="polite"
          aria-busy="true"
          className="flex w-full max-w-sm flex-col items-center rounded-2xl border border-card-border bg-card p-6 text-center shadow-[var(--nibi-shadow-card)]"
        >
          <span className="relative flex size-16 items-center justify-center rounded-2xl border border-card-border bg-surface shadow-xs">
            <DevicePlatformIcon platform={device?.platform} className="size-7 text-foreground" />
            {statusBadge}
          </span>
          <h1 className="mt-4 max-w-full font-display text-ui-xl font-semibold break-words text-balance text-foreground">
            {name ? copy.connectingTo(name) : copy.connectingFallback}
          </h1>
          <p className="mt-2.5 inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-ui-sm text-foreground-subtle">
            <NibiWorkingIndicator compact phase={state === "paired" ? "generating" : "starting"} />
            <span className="text-pretty">{stage.label}</span>
          </p>
          {stage.description ? (
            <p className="mt-2.5 max-w-xs text-ui-sm leading-relaxed text-pretty text-foreground-subtle">
              {stage.description}
            </p>
          ) : null}
          <ol
            className="mt-5 w-full space-y-2 rounded-xl border border-border bg-surface/70 p-3.5 text-left"
            aria-label={copy.steps.join(" → ")}
          >
            {copy.steps.map((step, index) => {
              const stepState =
                stepIndex === undefined
                  ? "idle"
                  : index < stepIndex
                    ? "done"
                    : index === stepIndex
                      ? "active"
                      : "pending";
              return (
                <li
                  key={step}
                  aria-current={index === stepIndex ? "step" : undefined}
                  data-step-state={stepState}
                  className="flex items-center gap-2.5 text-ui-sm"
                >
                  {stepState === "done" ? (
                    <span
                      aria-hidden="true"
                      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-success text-success-foreground"
                    >
                      <CheckIcon className="size-3" />
                    </span>
                  ) : stepState === "active" ? (
                    <span
                      aria-hidden="true"
                      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary ring-1 ring-primary/35"
                    >
                      <LoaderCircleIcon className="size-3 animate-spin motion-reduce:animate-none" />
                    </span>
                  ) : (
                    <span
                      aria-hidden="true"
                      className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-card text-ui-xs font-medium text-foreground-subtle"
                    >
                      {index + 1}
                    </span>
                  )}
                  <span
                    className={
                      stepState === "active"
                        ? "font-medium text-foreground"
                        : "text-foreground-subtle"
                    }
                  >
                    {step}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>
    </div>
  );
}
