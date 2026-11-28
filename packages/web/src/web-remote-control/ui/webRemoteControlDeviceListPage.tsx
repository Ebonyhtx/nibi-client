import { useState } from "react";
import { AlertCircleIcon, ChevronRightIcon, LaptopIcon, RefreshCwIcon } from "lucide-react";
import { Button } from "@nibi/ui/button";
import { DevicePlatformIcon, getDevicePlatformLabel } from "@nibi/ui/device-platform-icon";
import { WebRemoteControlBrand } from "#src/web-remote-control/ui/webRemoteControlBrand.js";
import {
  WebRemoteControlConnectionSheet,
  WebRemoteControlDeviceRow,
} from "#src/web-remote-control/ui/webRemoteControlConnectionSheet.js";
import type {
  WebRemoteControlDeviceGroup,
  WebRemoteControlDeviceListAccount,
  WebRemoteControlDeviceListView,
} from "#src/web-remote-control/contract.js";

import type { WebRemoteControlScreenLocale } from "#src/web-remote-control/domain/webRemoteControlScreenCopy.js";
import { WebRemoteControlSwitchAccountDialog } from "#src/web-remote-control/ui/webRemoteControlSwitchAccountDialog.js";

const copyByLocale = {
  "zh-CN": {
    title: "选择电脑",
    switchAccount: "切换",
    switchAccountFallback: "切换账号",
    refresh: "刷新",
    loading: "正在加载设备…",
    online: "在线",
    offline: "离线",
    unnamed: "未命名设备",
    connections: (count: number) => `${count} 个连接`,
    notFound: "没看到你的电脑？在电脑端 NIBI 登录同一账号并开启远程控制，然后刷新。",
    emptyTitle: "暂无设备",
    emptyDescription: "在电脑端登录同一账号并开启 Web 远程控制，然后刷新列表。",
    error: "无法加载设备，请检查网络后刷新。",
  },
  "en-US": {
    title: "Choose a computer",
    switchAccount: "Switch",
    switchAccountFallback: "Switch account",
    refresh: "Refresh",
    loading: "Loading devices…",
    online: "Online",
    offline: "Offline",
    unnamed: "Unnamed device",
    connections: (count: number) => `${count} connections`,
    notFound:
      "Don't see your computer? Sign in to NIBI on it with the same account, turn on remote control, then refresh.",
    emptyTitle: "No devices yet",
    emptyDescription:
      "Sign in with the same account on your computer, enable Web remote control, then refresh this list.",
    error: "Could not load devices. Check your connection and refresh.",
  },
};

type DeviceListCopy = (typeof copyByLocale)["zh-CN"];

const PROVIDER_LABELS: Record<WebRemoteControlDeviceListAccount["provider"], string> = {
  nibi: "NIBI",
};

interface WebRemoteControlDeviceListPageProps {
  view: WebRemoteControlDeviceListView;
  locale: WebRemoteControlScreenLocale;
  onSelect(sid: string): void;
  onRefresh(): void;
  onSwitchAccount(): void;
  /** 多连接弹层的“启动于”相对时间基准，测试注入。 */
  now?: () => number;
}

function SectionHeader({
  label,
  count,
  online,
}: {
  label: string;
  count: number;
  online?: boolean;
}) {
  return (
    <h2 className="flex items-center gap-1.5 px-1 pt-6 pb-2 text-ui-sm font-medium text-foreground-subtle">
      {online ? <span aria-hidden="true" className="size-1.5 rounded-full bg-success" /> : null}
      <span>
        {label}
        <span className="ml-1.5 inline-flex items-center rounded-full bg-surface px-2 py-0.5 text-ui-xs font-medium text-foreground-subtle">
          {count}
        </span>
      </span>
    </h2>
  );
}

function DeviceTile({ platform, online }: { platform?: string; online: boolean }) {
  return (
    <span className="relative flex size-10 shrink-0 items-center justify-center rounded-xl border border-border/70 bg-surface text-foreground">
      <DevicePlatformIcon platform={platform} className="size-5" />
      {online ? (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full bg-success ring-2 ring-card"
        />
      ) : null}
    </span>
  );
}

function describeDevice(
  device: WebRemoteControlDeviceGroup,
  copy: DeviceListCopy,
  showId: boolean,
): string {
  const platform = getDevicePlatformLabel(device.platform);
  const online = device.onlineConnections.length > 0;
  const single = device.onlineConnections.length === 1 ? device.onlineConnections[0] : undefined;
  const version = single?.meta.version?.trim();
  const parts = online
    ? [platform, version ? `NIBI ${version}` : undefined]
    : [platform, copy.offline];
  const filtered = parts.filter((part): part is string => Boolean(part));
  if (filtered.length === 0) filtered.push(online ? copy.online : copy.offline);
  // 设备 ID 默认隐藏；同组重名时才追加 MID 前 8 位区分，前 8 位不参与身份判断。
  if (showId) filtered.push(`ID ${device.deviceMid.slice(0, 8)}`);
  return filtered.join(" · ");
}

function DeviceSection({
  label,
  devices,
  copy,
  selectable,
  onlineSection,
  onOpen,
}: {
  label: string;
  devices: WebRemoteControlDeviceGroup[];
  copy: DeviceListCopy;
  selectable: boolean;
  onlineSection?: boolean;
  onOpen(device: WebRemoteControlDeviceGroup): void;
}) {
  if (devices.length === 0) return null;
  const nameCounts = new Map<string, number>();
  for (const device of devices) {
    const name = device.name || copy.unnamed;
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  return (
    <section>
      <SectionHeader label={label} count={devices.length} online={onlineSection} />
      <ul className="overflow-hidden rounded-2xl border border-card-border bg-card shadow-[var(--nibi-shadow-card)]">
        {devices.map((device, index) => {
          const name = device.name || copy.unnamed;
          const online = device.onlineConnections.length > 0;
          const multiple = device.onlineConnections.length > 1;
          return (
            <li key={device.deviceMid}>
              <WebRemoteControlDeviceRow
                first={index === 0}
                // 全离线行原生禁用；在线行在刷新中/失败时也暂不可选，沿用入口 admission。
                disabled={!online || !selectable}
                onClick={() => onOpen(device)}
                dimmed={!online}
                leading={<DeviceTile platform={device.platform} online={online} />}
                trailing={
                  online ? (
                    <>
                      {multiple ? (
                        <span className="shrink-0 rounded-full border border-border bg-surface px-2.5 py-0.5 text-ui-xs font-medium text-foreground-subtle">
                          {copy.connections(device.onlineConnections.length)}
                        </span>
                      ) : null}
                      <ChevronRightIcon
                        aria-hidden="true"
                        className="size-4 shrink-0 text-foreground-subtle"
                      />
                    </>
                  ) : null
                }
              >
                <span className="block truncate text-ui-base font-medium">{name}</span>
                <span className="mt-0.5 block truncate text-ui-sm text-foreground-subtle">
                  {describeDevice(device, copy, (nameCounts.get(name) ?? 0) > 1)}
                </span>
              </WebRemoteControlDeviceRow>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AccountRow({
  account,
  copy,
  locale,
  onSwitchAccount,
}: {
  account?: WebRemoteControlDeviceListAccount;
  copy: DeviceListCopy;
  locale: WebRemoteControlScreenLocale;
  onSwitchAccount(): void;
}) {
  const switchButton = (label: string) => (
    <WebRemoteControlSwitchAccountDialog locale={locale} onConfirm={onSwitchAccount}>
      <Button
        type="button"
        variant="ghost"
        className="h-11 shrink-0 rounded-lg px-2.5 text-ui-sm font-medium text-primary hover:bg-hover focus-visible:bg-hover"
      >
        {label}
      </Button>
    </WebRemoteControlSwitchAccountDialog>
  );
  if (!account) {
    return (
      <div className="mt-3 flex items-center justify-end rounded-xl border border-card-border bg-card px-3 py-1 shadow-[var(--nibi-shadow-card)]">
        {switchButton(copy.switchAccountFallback)}
      </div>
    );
  }
  return (
    <div className="mt-3 flex min-w-0 items-center gap-2.5 rounded-xl border border-card-border bg-card py-1.5 pr-1.5 pl-3 shadow-[var(--nibi-shadow-card)]">
      {account.avatarUrl ? (
        <img
          src={account.avatarUrl}
          alt=""
          aria-hidden="true"
          className="size-7 shrink-0 rounded-full object-cover"
        />
      ) : (
        <span
          aria-hidden="true"
          className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-ui-xs font-semibold text-primary"
        >
          {Array.from(account.displayName.trim())[0]?.toUpperCase() ?? "?"}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground-subtle">
        {account.displayName} · {PROVIDER_LABELS[account.provider]}
      </span>
      {switchButton(copy.switchAccount)}
    </div>
  );
}

export function WebRemoteControlDeviceListPage({
  view,
  locale,
  onSelect,
  onRefresh,
  onSwitchAccount,
  now = () => Date.now(),
}: WebRemoteControlDeviceListPageProps) {
  const copy = copyByLocale[locale];
  const [sheetDeviceMid, setSheetDeviceMid] = useState<string | null>(null);
  const selectable = !view.loading && !view.error;
  const onlineDevices = view.devices.filter((device) => device.onlineConnections.length > 0);
  const offlineDevices = view.devices.filter((device) => device.onlineConnections.length === 0);
  const sheetDevice = onlineDevices.find((device) => device.deviceMid === sheetDeviceMid);
  const openDevice = (device: WebRemoteControlDeviceGroup) => {
    const [only, ...others] = device.onlineConnections;
    if (!only) return;
    if (others.length === 0) onSelect(only.device_sid);
    else setSheetDeviceMid(device.deviceMid);
  };

  // 全局 body/#root 禁止滚动；入口自己承接长列表，保证末行可达。
  return (
    <main className="h-dvh overflow-y-auto bg-sidebar text-foreground">
      <div className="mx-auto w-full max-w-md pt-[calc(env(safe-area-inset-top)+12px)] pr-[max(1rem,env(safe-area-inset-right))] pb-[calc(env(safe-area-inset-bottom)+2.5rem)] pl-[max(1rem,env(safe-area-inset-left))]">
        <div className="flex h-10 items-center">
          <WebRemoteControlBrand subtitle={locale === "zh-CN" ? "Web 远程控制" : "Web Remote"} />
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <h1 className="font-display text-ui-2xl font-semibold text-balance">{copy.title}</h1>
          <Button
            type="button"
            variant="ghost"
            aria-label={copy.refresh}
            title={copy.refresh}
            disabled={view.loading}
            onClick={onRefresh}
            className="-mr-2 size-11 rounded-xl text-foreground-subtle hover:bg-hover focus-visible:bg-hover"
          >
            <RefreshCwIcon
              className={[
                "size-[18px]",
                view.loading ? "animate-spin motion-reduce:animate-none" : "",
              ].join(" ")}
            />
          </Button>
        </div>
        <AccountRow
          account={view.account}
          copy={copy}
          locale={locale}
          onSwitchAccount={onSwitchAccount}
        />

        {view.error ? (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2.5 rounded-xl border border-destructive/25 bg-destructive-surface px-3.5 py-3 text-ui-sm text-destructive-surface-foreground"
          >
            <AlertCircleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <p className="text-pretty">{copy.error}</p>
          </div>
        ) : null}
        <div aria-busy={view.loading}>
          {view.devices.length > 0 ? (
            <>
              <DeviceSection
                label={copy.online}
                devices={onlineDevices}
                copy={copy}
                selectable={selectable}
                onlineSection
                onOpen={openDevice}
              />
              <DeviceSection
                label={copy.offline}
                devices={offlineDevices}
                copy={copy}
                selectable={selectable}
                onOpen={openDevice}
              />
              <p className="mt-4 rounded-xl border border-border/70 bg-surface/70 px-3.5 py-2.5 text-ui-xs leading-relaxed text-pretty text-foreground-subtle">
                {copy.notFound}
              </p>
            </>
          ) : view.loading ? (
            <div className="mt-6">
              <div
                aria-hidden="true"
                className="overflow-hidden rounded-2xl border border-card-border bg-card shadow-[var(--nibi-shadow-card)]"
              >
                {[0, 1].map((rowIndex) => (
                  <div
                    key={rowIndex}
                    className={[
                      "flex items-center gap-3.5 px-4 py-3.5",
                      rowIndex > 0 ? "border-t border-border" : "",
                    ].join(" ")}
                  >
                    <div className="size-10 shrink-0 animate-pulse rounded-xl bg-surface motion-reduce:animate-none" />
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="h-3.5 w-32 animate-pulse rounded-md bg-surface motion-reduce:animate-none" />
                      <div className="h-3 w-44 animate-pulse rounded-md bg-surface motion-reduce:animate-none" />
                    </div>
                  </div>
                ))}
              </div>
              <p role="status" className="mt-4 text-center text-ui-sm text-foreground-subtle">
                {copy.loading}
              </p>
            </div>
          ) : !view.error ? (
            <div className="mt-6 flex flex-col items-center rounded-2xl border border-card-border bg-card px-6 py-10 text-center shadow-[var(--nibi-shadow-card)]">
              <span className="flex size-14 items-center justify-center rounded-2xl border border-border bg-surface text-foreground-subtle">
                <LaptopIcon aria-hidden="true" className="size-7" />
              </span>
              <p className="mt-4 text-ui-base font-semibold text-balance">{copy.emptyTitle}</p>
              <p className="mt-1.5 text-ui-sm leading-relaxed text-pretty text-foreground-subtle">
                {copy.emptyDescription}
              </p>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="mt-5 h-11 rounded-xl px-5"
                onClick={onRefresh}
              >
                <RefreshCwIcon />
                {copy.refresh}
              </Button>
            </div>
          ) : null}
        </div>
      </div>
      <WebRemoteControlConnectionSheet
        device={sheetDevice}
        locale={locale}
        disabled={!selectable}
        now={now}
        onClose={() => setSheetDeviceMid(null)}
        onSelect={(sid) => {
          setSheetDeviceMid(null);
          onSelect(sid);
        }}
      />
    </main>
  );
}
