import {
  isSameWebRemoteControlTarget,
  isReusableWebRemoteControlSession,
  getStatusLabel,
  getStatusDetail,
  getStatusDotClassName,
  getWebRemoteControlStatusTagLabel,
  isSameWebRemoteControlStatus,
  getFailureDescription,
} from "@/web-remote-control/domain/presentation.js";
import { memo, useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import type { BotProvider, WebRemoteControlStatus } from "@nibi/shared";
import { NIBI_PROVIDER_ID } from "@nibi/shared";
import {
  Bot as BotIcon,
  ChevronRightIcon,
  CopyIcon,
  LoaderCircle,
  MonitorSmartphone,
  Smartphone,
  Unplug,
  XIcon,
} from "lucide-react";
import { BotsDialog } from "@/BotsDialog.js";
import { ProviderIcon } from "@/BotsDialog/shared.js";
import { Button } from "@/components/ui/button.js";
import { NibiWorkingIndicator } from "@/components/mobile-ui/NibiWorkingIndicator.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { toast } from "@/components/ui/toast.js";
import { useNibiStore } from "@/store/StoreProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useOAuth } from "@/hooks/useOAuth.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { getBotProviderRegionTagLabelId } from "@/botsUi.js";

type RemoteControlBotProvider = Extract<BotProvider, "weixin" | "feishu" | "lark" | "telegram">;

const REMOTE_CONTROL_BOT_ENTRIES: Array<{
  provider: RemoteControlBotProvider;
}> = [
  { provider: "weixin" },
  { provider: "feishu" },
  { provider: "lark" },
  { provider: "telegram" },
];

function getStatusPillClassName(status: WebRemoteControlStatus): string {
  switch (status.status) {
    case "active":
      return "border-success/25 bg-success-surface text-success-surface-foreground";
    case "error":
      return "border-destructive/25 bg-destructive-surface text-destructive-surface-foreground";
    case "idle":
      return "border-border bg-card text-foreground-subtle";
    default:
      return "border-warning/25 bg-warning-surface text-warning-surface-foreground";
  }
}

function WebRemoteControlLoginButton({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { intl } = useNibiIntl();
  const requestLoginEntry = useNibiStore((state) => state.requestLoginEntry);
  const { loadingProviders } = useOAuth();

  return (
    <Button
      type="button"
      data-testid="web-remote-control-login"
      className="enabled:cursor-pointer"
      disabled={loadingProviders}
      onClick={() => {
        // 远控中继只认 NIBI 账号（relay 的 401 就是 NIBI token 失效）：显式指定 provider。
        // 不传 provider 时缓存用户会被统一入口当成"已登录"直接关页，远控仍然进不去。
        onOpenChange(false);
        requestLoginEntry(NIBI_PROVIDER_ID, "app-login");
      }}
    >
      {intl.formatMessage({ id: "webRemoteControl.authRequired.login" })}
    </Button>
  );
}

export const WebRemoteControlDialog = memo(function WebRemoteControlDialogComponent({
  open,
  onOpenChange,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  initialTaskId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  initialTaskId?: string;
}) {
  const platform = usePlatform();
  const { intl } = useNibiIntl();
  const [status, setStatus] = useState<WebRemoteControlStatus>({
    status: "idle",
  });
  const [loading, setLoading] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [botsDialogOpen, setBotsDialogOpen] = useState(false);
  const [botEntryProvider, setBotEntryProvider] = useState<RemoteControlBotProvider | null>(null);

  const statusLabel = useMemo(
    () => getStatusLabel(status, intl.formatMessage),
    [intl.formatMessage, status],
  );
  const statusDetail = useMemo(
    () => getStatusDetail(status, intl.formatMessage),
    [intl.formatMessage, status],
  );
  const failureDescription = useMemo(
    () => getFailureDescription(status.failure, intl.formatMessage),
    [intl.formatMessage, status.failure],
  );
  const statusTagLabel = useMemo(
    () => getWebRemoteControlStatusTagLabel(status, intl.formatMessage),
    [intl.formatMessage, status],
  );
  const statusDotClassName = getStatusDotClassName(status);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;

    const syncWebRemoteControlStatus = async () => {
      setLoading(true);

      try {
        const currentStatus = await platform.getWebRemoteControlStatus();
        let nextStatus: WebRemoteControlStatus;
        if (
          currentStatus.status === "auth-required" ||
          isSameWebRemoteControlTarget(
            currentStatus,
            workspacePath,
            workspaceIdentity,
            remoteSessionId,
          ) ||
          isReusableWebRemoteControlSession(currentStatus)
        ) {
          nextStatus = currentStatus;
        } else {
          const startResult = await platform.startWebRemoteControl({
            workspacePath,
            workspaceIdentity,
            remoteSessionId,
            initialTaskId,
          });
          // 兼容仍可返回 cancelled 的平台实现；当前 Desktop 不再叠加原生确认。
          nextStatus = startResult.status === "cancelled" ? { status: "idle" } : startResult;
        }
        // Bugfix: 手机端默认主题已统一收敛到 dark，不再依赖二维码 URL 透传 theme。
        // 这里去掉启动参数里的 theme，避免桌面端主题无意义地参与远控链路。

        if (!cancelled) {
          setStatus(nextStatus);
          logger.info("[WebRemoteControlDialog] Web 远程控制状态已同步", {
            workspacePath,
            workspaceIdentity: workspaceIdentity ?? "none",
            remoteSessionId: remoteSessionId ?? "none",
            initialTaskId: initialTaskId ?? "none",
            status: nextStatus.status,
            sessionId: nextStatus.sessionId ?? "none",
          });
        }
      } catch (error) {
        const currentStatus = await platform.getWebRemoteControlStatus().catch(() => null);
        if (currentStatus?.status === "auth-required") {
          if (!cancelled) setStatus(currentStatus);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (!cancelled) {
          setStatus({
            status: "error",
            workspacePath,
            remoteSessionId,
            error: message,
          });
          toast(intl.formatMessage({ id: "webRemoteControl.startFailed" }, { error: message }));
        }
        logger.error("[WebRemoteControlDialog] 启动 Web 远程控制失败", {
          workspacePath,
          workspaceIdentity: workspaceIdentity ?? "none",
          remoteSessionId: remoteSessionId ?? "none",
          initialTaskId: initialTaskId ?? "none",
          error: message,
        });
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void syncWebRemoteControlStatus();

    return () => {
      cancelled = true;
    };
  }, [intl, open, platform, remoteSessionId, workspaceIdentity, workspacePath, initialTaskId]);

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;

    const pollWebRemoteControlStatus = async () => {
      try {
        const nextStatus = await platform.getWebRemoteControlStatus();
        if (cancelled) {
          return;
        }

        const shouldApplyStatus =
          isSameWebRemoteControlTarget(
            nextStatus,
            workspacePath,
            workspaceIdentity,
            remoteSessionId,
          ) ||
          isReusableWebRemoteControlSession(nextStatus) ||
          nextStatus.status === "auth-required" ||
          nextStatus.status === "idle" ||
          nextStatus.status === "error";
        if (!shouldApplyStatus) {
          return;
        }

        setStatus((currentStatus) =>
          isSameWebRemoteControlStatus(currentStatus, nextStatus) ? currentStatus : nextStatus,
        );
      } catch {
        // Bugfix: Web 远程控制的状态变化发生在 main / relay 侧，
        // 如果弹层只在打开时同步一次，状态会长期停在“等待连接”。
        // 这里用轻量轮询补齐状态刷新；单次失败时静默忽略，避免打断用户操作。
      }
    };

    const intervalId = window.setInterval(() => {
      void pollWebRemoteControlStatus();
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [open, platform, remoteSessionId, workspaceIdentity, workspacePath]);

  useEffect(() => {
    if (!status.qrUrl) {
      setQrDataUrl(null);
      return;
    }

    let cancelled = false;
    setQrDataUrl(null);

    void QRCode.toDataURL(status.qrUrl, {
      margin: 1,
      width: 320,
    })
      .then((dataUrl: string) => {
        if (!cancelled) {
          setQrDataUrl(dataUrl);
        }
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[WebRemoteControlDialog] 生成二维码失败", message);
      });

    return () => {
      cancelled = true;
    };
  }, [status.qrUrl]);

  const handleCopyLink = async () => {
    if (!status.connectUrl) {
      return;
    }

    try {
      await navigator.clipboard.writeText(status.connectUrl);
      toast(intl.formatMessage({ id: "webRemoteControl.copyLink.copied" }));
      logger.info("[WebRemoteControlDialog] 已复制 Web 远程控制链接", {
        workspacePath,
        remoteSessionId: remoteSessionId ?? "none",
        sessionId: status.sessionId ?? "none",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(intl.formatMessage({ id: "webRemoteControl.copyLinkFailed" }, { error: message }));
      logger.error("[WebRemoteControlDialog] 复制 Web 远程控制链接失败", message);
    }
  };

  const handleStop = async () => {
    setLoading(true);
    try {
      await platform.stopWebRemoteControl();
      setStatus({ status: "idle" });
      onOpenChange(false);
      toast(intl.formatMessage({ id: "webRemoteControl.stopSuccess" }));
      logger.info("[WebRemoteControlDialog] 已关闭 Web 远程控制", {
        workspacePath,
        remoteSessionId: remoteSessionId ?? "none",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast(intl.formatMessage({ id: "webRemoteControl.stopFailed" }, { error: message }));
      logger.error("[WebRemoteControlDialog] 关闭 Web 远程控制失败", message);
    } finally {
      setLoading(false);
    }
  };

  const handleDialogOpenChange = (nextOpen: boolean) => {
    logger.info("[WebRemoteControlDialog] 弹层开关状态变化", {
      workspacePath,
      remoteSessionId: remoteSessionId ?? "none",
      nextOpen,
    });
    onOpenChange(nextOpen);
  };

  const handleDismiss = () => {
    logger.info("[WebRemoteControlDialog] 用户点击右上角关闭按钮", {
      workspacePath,
      remoteSessionId: remoteSessionId ?? "none",
      sessionId: status.sessionId ?? "none",
      status: status.status,
    });
    handleDialogOpenChange(false);
  };

  const handleOpenBotEntry = (provider: RemoteControlBotProvider) => {
    setBotEntryProvider(provider);
    setBotsDialogOpen(true);
    logger.info("[WebRemoteControlDialog] 打开 Bot Channel 配置入口", {
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? "none",
      provider,
    });
  };

  const handleOpenBotsDialog = () => {
    setBotEntryProvider(null);
    setBotsDialogOpen(true);
    logger.info("[WebRemoteControlDialog] 打开 Bots 总配置入口", {
      workspacePath,
      workspaceIdentity: workspaceIdentity ?? "none",
    });
  };

  return (
    <>
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogContent
          showCloseButton={false}
          // Bugfix: Mobile Remote Control 弹窗之前比 Remote Connect 更宽也更贴近窗口边缘，
          // 启动二维码和 Bot Channel 内容时会显得层级不一致。这里复用 Remote Connect 的外层尺寸，
          // 但不强制撑满高度；远控内容比 Remote Connect 少，内容自适应能避免窗口显得空。
          className="max-h-[calc(100vh-6rem)] max-w-4xl gap-0 overflow-hidden rounded-2xl p-0"
        >
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            // Bugfix: 这个弹窗会贴近桌面窗口顶部显示，默认 close 在 Electron drag 区里容易点不中。
            // 这里改成显式点击关闭，并把按钮本身标成 no-drag，保证右上角关闭动作能稳定命中。
            // Bugfix: 远控弹层内可点击控件之前没有显式 pointer cursor，桌面端 hover 时不像可操作元素。
            // 这里仅给启用态补手指指针，禁用态仍沿用 Button 的 disabled 交互语义。
            className="absolute top-2 right-2 enabled:cursor-pointer [app-region:no-drag]"
            onClick={handleDismiss}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </Button>
          <div
            data-testid="web-remote-control-dialog-scroll"
            className="max-h-[calc(100vh-6rem)] min-h-0 overflow-y-auto p-5"
          >
            <DialogHeader className="space-y-1 pr-8">
              <div className="flex items-center gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border bg-surface text-primary">
                  <MonitorSmartphone className="size-5" />
                </div>
                <div className="min-w-0 space-y-0.5">
                  <DialogTitle>{intl.formatMessage({ id: "webRemoteControl.title" })}</DialogTitle>
                  <DialogDescription>
                    {intl.formatMessage({ id: "webRemoteControl.description" })}
                  </DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div
              data-testid="web-remote-control-main-grid"
              className="mt-4 grid gap-4 md:grid-cols-[minmax(0,1.4fr)_minmax(300px,1fr)]"
            >
              <section
                data-testid="web-remote-control-scan-card"
                className="flex min-h-[340px] flex-col rounded-xl border border-border bg-card p-4"
              >
                {status.status === "auth-required" ? (
                  <div
                    data-testid="web-remote-control-auth-required"
                    className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-6 text-center"
                  >
                    <div className="flex size-12 items-center justify-center rounded-2xl border border-border bg-surface text-primary">
                      <MonitorSmartphone className="size-6" />
                    </div>
                    <div className="space-y-1.5">
                      <h3 className="text-ui-base font-semibold text-foreground">
                        {intl.formatMessage({ id: "webRemoteControl.authRequired.title" })}
                      </h3>
                      <p className="max-w-xs text-ui-sm leading-relaxed text-foreground-subtle">
                        {intl.formatMessage({ id: "webRemoteControl.authRequired.description" })}
                      </p>
                    </div>
                    <WebRemoteControlLoginButton onOpenChange={onOpenChange} />
                  </div>
                ) : (
                  <>
                    <div className="mb-3 flex items-start gap-2.5">
                      <span
                        aria-hidden="true"
                        className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface text-primary"
                      >
                        <Smartphone className="size-4" />
                      </span>
                      <div className="min-w-0 space-y-0.5">
                        <div className="text-ui-base font-semibold text-foreground">
                          {intl.formatMessage({
                            id: "webRemoteControl.mobileQr.title",
                          })}
                        </div>
                        <p className="text-ui-sm leading-relaxed text-foreground-subtle">
                          {intl.formatMessage({
                            id: "webRemoteControl.mobileQr.description",
                          })}
                        </p>
                      </div>
                    </div>

                    <div
                      data-testid="web-remote-control-connection-card"
                      className="mb-3 rounded-xl border border-border/80 bg-surface/80 p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2.5">
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <div className="text-ui-sm font-semibold text-foreground">
                              {statusLabel}
                            </div>
                            <div
                              className={`inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-ui-xs font-medium ${getStatusPillClassName(status)}`}
                            >
                              <span
                                className={`size-1.5 shrink-0 rounded-full ${statusDotClassName}`}
                              />
                              <span className="truncate">{statusTagLabel}</span>
                            </div>
                          </div>
                          <div className="text-ui-xs leading-relaxed text-foreground-subtle">
                            {statusDetail}
                          </div>
                        </div>
                        {loading ? (
                          <LoaderCircle className="size-4 animate-spin text-foreground-subtle motion-reduce:animate-none" />
                        ) : (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="shrink-0 gap-1.5 enabled:cursor-pointer"
                            onClick={() => void handleStop()}
                            disabled={status.status === "idle"}
                          >
                            <Unplug className="size-3.5" />
                            {intl.formatMessage({ id: "webRemoteControl.stop" })}
                          </Button>
                        )}
                      </div>
                      {failureDescription ? (
                        <div className="mt-2.5 rounded-lg border border-destructive/20 bg-destructive-surface px-3 py-2 text-ui-xs leading-relaxed text-destructive-surface-foreground">
                          <p>{failureDescription}</p>
                          {status.failure?.message &&
                          status.failure.message !== failureDescription ? (
                            <p className="mt-1 opacity-85">{status.failure.message}</p>
                          ) : null}
                        </div>
                      ) : status.error ? (
                        <p className="mt-2.5 text-ui-xs leading-relaxed text-destructive">
                          {status.error}
                        </p>
                      ) : null}
                      <div
                        data-testid="web-remote-control-copy-link-row"
                        className="mt-2.5 flex items-center justify-between gap-2.5 border-t border-border pt-2.5"
                      >
                        <div className="min-w-0 flex-1 text-ui-xs leading-relaxed text-foreground-subtle">
                          {intl.formatMessage({
                            id: "webRemoteControl.copyLink.description",
                          })}
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="shrink-0 gap-1.5 enabled:cursor-pointer"
                          onClick={() => void handleCopyLink()}
                          disabled={!status.connectUrl || loading}
                        >
                          <CopyIcon className="size-3.5" />
                          {intl.formatMessage({ id: "webRemoteControl.copyLink" })}
                        </Button>
                      </div>
                    </div>

                    <div className="flex min-h-0 flex-1 items-center justify-center rounded-xl border border-border bg-surface/50 px-4 py-4">
                      {qrDataUrl ? (
                        <div className="relative rounded-2xl bg-white p-3.5 shadow-[var(--nibi-shadow-card)] ring-1 ring-black/8">
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute -top-1 -left-1 size-4 rounded-tl-md border-t-2 border-l-2 border-primary/45"
                          />
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute -top-1 -right-1 size-4 rounded-tr-md border-t-2 border-r-2 border-primary/45"
                          />
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute -bottom-1 -left-1 size-4 rounded-bl-md border-b-2 border-l-2 border-primary/45"
                          />
                          <span
                            aria-hidden="true"
                            className="pointer-events-none absolute -right-1 -bottom-1 size-4 rounded-br-md border-r-2 border-b-2 border-primary/45"
                          />
                          <img
                            src={qrDataUrl}
                            alt={intl.formatMessage({ id: "webRemoteControl.qrAlt" })}
                            className="size-52 max-w-full rounded-md"
                          />
                        </div>
                      ) : (
                        <div className="flex flex-col items-center gap-3 py-8 text-center text-ui-sm text-foreground-subtle">
                          <NibiWorkingIndicator
                            phase="starting"
                            label={intl.formatMessage({
                              id: "webRemoteControl.generating",
                            })}
                          />
                        </div>
                      )}
                    </div>
                  </>
                )}
              </section>

              <section className="flex min-h-[340px] flex-col rounded-xl border border-border bg-card p-4">
                <div className="mb-3 flex items-start gap-2.5">
                  <span
                    aria-hidden="true"
                    className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface text-foreground-subtle"
                  >
                    <BotIcon className="size-4" />
                  </span>
                  <div className="min-w-0 space-y-0.5">
                    <div className="text-ui-base font-semibold text-foreground">
                      {intl.formatMessage({
                        id: "webRemoteControl.botChannel.title",
                      })}
                    </div>
                    <p className="text-ui-sm leading-relaxed text-foreground-subtle">
                      {intl.formatMessage({
                        id: "webRemoteControl.botChannel.description",
                      })}
                    </p>
                  </div>
                </div>
                <div className="grid min-h-0 flex-1 gap-2.5">
                  {REMOTE_CONTROL_BOT_ENTRIES.map((entry) => {
                    const regionTagLabelId = getBotProviderRegionTagLabelId(entry.provider);

                    return (
                      <button
                        key={entry.provider}
                        type="button"
                        className="group flex min-h-0 cursor-pointer items-center gap-3 rounded-xl border border-border/70 bg-surface/60 px-3 py-2.5 text-left transition-colors hover:border-border-hover hover:bg-surface-hover focus-visible:border-input-border-focused"
                        onClick={() => handleOpenBotEntry(entry.provider)}
                      >
                        {/* Bugfix: 远控 Bot Channel 入口原来用通用 lucide 图标，用户无法一眼区分微信、飞书和 Telegram。
                            这里直接复用 BotsDialog 的渠道 logo，不再额外包裹容器，保证品牌图标本身作为视觉识别。 */}
                        <ProviderIcon provider={entry.provider} className="size-10 shrink-0" />
                        <span className="min-w-0 flex-1 space-y-0.5">
                          <span className="flex min-w-0 items-center gap-1.5 text-ui-sm font-semibold text-foreground">
                            <span className="min-w-0 truncate">
                              {intl.formatMessage({
                                id: `webRemoteControl.botChannel.${entry.provider}.title`,
                              })}
                            </span>
                            {regionTagLabelId ? (
                              <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border bg-card px-2 text-ui-xs font-medium leading-none text-foreground-subtle">
                                {intl.formatMessage({ id: regionTagLabelId })}
                              </span>
                            ) : null}
                          </span>
                          <span className="block text-ui-xs leading-relaxed text-foreground-subtle">
                            {intl.formatMessage({
                              id: `webRemoteControl.botChannel.${entry.provider}.description`,
                            })}
                          </span>
                        </span>
                        <span className="inline-flex shrink-0 items-center gap-0.5 text-ui-xs font-medium text-foreground-subtle transition-colors group-hover:text-primary">
                          {intl.formatMessage({
                            id: "webRemoteControl.botChannel.configure",
                          })}
                          <ChevronRightIcon aria-hidden="true" className="size-3.5" />
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="default"
                    data-testid="web-remote-control-open-bots"
                    className="h-9 w-full justify-center gap-2 rounded-lg enabled:cursor-pointer"
                    onClick={handleOpenBotsDialog}
                  >
                    <BotIcon className="size-3.5" />
                    {intl.formatMessage({
                      id: "webRemoteControl.botChannel.manageBots",
                    })}
                  </Button>
                </div>
              </section>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <BotsDialog
        open={botsDialogOpen}
        onOpenChange={setBotsDialogOpen}
        entryProvider={botEntryProvider}
      />
    </>
  );
});
