import { QrCodeIcon } from "lucide-react";
import { WebRemoteControlBrand } from "#src/web-remote-control/ui/webRemoteControlBrand.js";

export function WebRemoteControlScanPage({ locale }: { locale: "zh-CN" | "en-US" }) {
  const zh = locale === "zh-CN";
  const steps = zh
    ? [
        "在电脑端打开 NIBI 并登录同一账号",
        "打开工作区右上角的「Web 远程控制」",
        "使用手机相机扫描屏幕上的二维码",
      ]
    : [
        "Open NIBI on your computer with the same account",
        "Open Web Remote Control from the workspace toolbar",
        "Scan the QR code with your phone camera",
      ];

  return (
    <main className="flex min-h-dvh flex-col bg-sidebar pt-[calc(env(safe-area-inset-top)+12px)] pr-[max(1rem,env(safe-area-inset-right))] pb-[calc(env(safe-area-inset-bottom)+24px)] pl-[max(1rem,env(safe-area-inset-left))] text-foreground">
      <div className="mx-auto flex h-10 w-full max-w-md items-center">
        <WebRemoteControlBrand subtitle={zh ? "Web 远程控制" : "Web Remote"} />
      </div>
      <div className="flex flex-1 items-center justify-center py-6">
        <section className="w-full max-w-sm rounded-2xl border border-card-border bg-card p-6 text-center shadow-[var(--nibi-shadow-card)]">
          <div
            aria-hidden="true"
            className="mx-auto flex size-14 items-center justify-center rounded-2xl border border-border bg-surface text-primary shadow-xs"
          >
            <QrCodeIcon className="size-7" />
          </div>
          <h1 className="mt-4 font-display text-ui-xl font-semibold text-balance text-foreground">
            {zh ? "请扫描桌面二维码" : "Scan the desktop QR code"}
          </h1>
          <p className="mt-2 text-ui-sm leading-relaxed text-pretty text-foreground-subtle">
            {zh
              ? "在电脑端打开 Web 远程控制，再用手机扫描二维码连接。"
              : "Open Web remote control on your computer, then scan its QR code to connect."}
          </p>
          <ol className="mt-5 space-y-2.5 rounded-xl border border-border bg-surface p-4 text-left text-ui-sm text-foreground-subtle">
            {steps.map((step, index) => (
              <li key={step} className="flex items-start gap-2.5">
                <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-card text-ui-xs font-medium text-foreground">
                  {index + 1}
                </span>
                <span className="min-w-0 text-pretty">{step}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );
}
