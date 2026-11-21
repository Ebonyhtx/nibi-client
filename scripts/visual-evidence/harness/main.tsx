import { StrictMode, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";
import { InteractionRequestOriginBadge } from "@/InteractionRequestOriginBadge.js";
import { FallbackToolCallBlock } from "@/ToolCallBlocks/renderers/fallback.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/fileSummaryTypes.js";
import nibiBirdIcon from "@/assets/nibi/nibi-bird.png";
import { buildToolDisplayModel } from "@/lib/toolDisplay.js";
import type { TaskChatToolCall } from "@/lib/taskChatMessageTypes.js";
import type { NibiInteractionRequestOrigin } from "@nibi/shared";
import "../../../packages/ui/src/styles.css";

const WORKSPACE = "C:\\workspace\\project";

function makeToolCall(
  overrides: Partial<TaskChatToolCall> & Pick<TaskChatToolCall, "toolId" | "status">,
): TaskChatToolCall {
  return {
    kind: "mcp",
    title: "vendor.unknown_tool",
    input: {
      path: "C:\\workspace\\project\\src\\widget.ts",
      operation: "vendor.audit",
      timeoutMs: 30000,
      dryRun: false,
      note: "unknown tool input rendered as a key/value table",
    },
    ...overrides,
  };
}

function makeContext(
  toolCall: TaskChatToolCall,
  options: {
    isRunning?: boolean;
    statusLabel?: string;
    errorText?: string;
  } = {},
): ToolCallBlockRenderContext {
  const displayModel = buildToolDisplayModel(toolCall, WORKSPACE);
  return {
    nestedToolRenderer: (() => null) as unknown as ComponentType<
      Parameters<typeof FallbackToolCallBlock>[0]
    >,
    toolCallNode: { toolCall, childToolCalls: [] },
    workspacePath: WORKSPACE,
    displayModel,
    viewerSource: displayModel.viewerSource,
    rawFileSummaries: [],
    isRunning: options.isRunning ?? false,
    statusLabel: options.statusLabel ?? toolCall.status,
    errorText: options.errorText,
    childToolList: null,
    forceOpen: true,
    canToggle: true,
    theme: "light",
  };
}

function Card({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 20 }} data-evidence-card={label}>
      <div
        style={{
          font: "600 12px/1.4 ui-sans-serif, system-ui",
          color: "#6b7280",
          margin: "0 0 6px 2px",
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          border: "1px solid #e5e7eb",
          borderRadius: 12,
          background: "#ffffff",
          padding: 12,
        }}
      >
        {children}
      </div>
    </section>
  );
}

const waitingContext = makeContext(
  makeToolCall({ toolId: "toolu_unknown_waiting", status: "running", output: undefined }),
  { isRunning: true, statusLabel: "running" },
);
const emptyContext = makeContext(
  makeToolCall({ toolId: "toolu_unknown_empty", status: "completed", output: undefined }),
  { statusLabel: "completed" },
);
const errorContext = makeContext(
  makeToolCall({ toolId: "toolu_unknown_error", status: "failed", output: undefined }),
  {
    statusLabel: "failed",
    errorText: "Unknown tool failed: vendor bridge returned HTTP 503",
  },
);
const resultContext = makeContext(
  makeToolCall({
    toolId: "toolu_unknown_result",
    status: "completed",
    output: {
      ok: false,
      code: "UNKNOWN_TOOL_RESULT",
      detail: "vendor bridge returned a structured error payload",
    },
  }),
  { statusLabel: "completed" },
);

const longSubagentOrigin: NibiInteractionRequestOrigin = {
  kind: "subagent",
  agentId: "agent-9f2c1d",
  agentType: "general-purpose",
  childSessionId: "session-child-9f2c1d",
  description:
    "workflow-alpha-site-very-long-subagent-name (alpha-site@1234567890) — repository-wide compliance audit worker",
  parentSessionId: "session-parent-77",
};

function DialogHeaderPreview({
  width,
  mode,
}: {
  width: number;
  mode: "permission" | "elicitation";
}) {
  return (
    <div
      data-evidence-dialog={mode}
      data-evidence-width={width}
      style={{
        width,
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        background: "#fff",
        padding: 12,
        boxSizing: "border-box",
      }}
    >
      {mode === "permission" ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-ui-base font-medium leading-tight text-foreground-subtle">
            Claude 请求权限
          </p>
          <InteractionRequestOriginBadge origin={longSubagentOrigin} />
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <span className="whitespace-pre-wrap break-words leading-6 text-foreground">
            请选择要应用到整个仓库的修复策略。
          </span>
          <InteractionRequestOriginBadge origin={longSubagentOrigin} className="mt-2" />
        </div>
      )}
      <div style={{ marginTop: 12, font: "12px/1.5 ui-sans-serif", color: "#9ca3af" }}>
        对话框宽度 {width}px · 长 subagent 名称用于验证徽标换行
      </div>
    </div>
  );
}

const fontSmoothingRule = `/* packages/ui/src/styles.css */
:root.platform-mac-desktop.font-smoothing-enabled {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

// packages/ui/src/settingsCodePreview.tsx
{isMacDesktop ? (
  <SettingsRow
    searchTarget="appearance.fontSmoothing"
    label={intl.formatMessage({ id: "settings.macFontSmoothing" })}
    control={
      <Switch
        checked={macFontSmoothingEnabled}
        data-testid="settings-macos-font-smoothing"
        onCheckedChange={setMacFontSmoothingEnabled}
      />
    }
  />
) : null}`;

function App() {
  return (
    <div
      style={{
        background: "#f8fafc",
        minHeight: "100vh",
        padding: 24,
        boxSizing: "border-box",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        color: "#111827",
      }}
    >
      <h1 style={{ font: "700 20px/1.3 ui-sans-serif", margin: "0 0 6px" }}>
        NIBI UI quick-win component harness
      </h1>
      <p style={{ font: "13px/1.5 ui-sans-serif", color: "#6b7280", margin: "0 0 24px" }}>
        组件级证据，不是完整 App。真实组件、真实 Tailwind 样式；没有 Electron 会话/服务。
      </p>

      <div data-evidence-section="fallback" style={{ maxWidth: 760 }}>
        <h2 style={{ font: "600 15px/1.4 ui-sans-serif", margin: "0 0 12px" }}>
          未知工具兜底卡（FallbackToolCallBlock）
        </h2>
        <Card label="未知工具 · 运行中（等待结果）">
          <FallbackToolCallBlock {...waitingContext} />
        </Card>
        <Card label="未知工具 · 完成但无结果">
          <FallbackToolCallBlock {...emptyContext} />
        </Card>
        <Card label="未知工具 · 错误">
          <FallbackToolCallBlock {...errorContext} />
        </Card>
        <Card label="未知工具 · 参数表 + 结果 + 复制按钮">
          <FallbackToolCallBlock {...resultContext} />
        </Card>
      </div>

      <div data-evidence-section="origin" style={{ marginTop: 36 }}>
        <h2 style={{ font: "600 15px/1.4 ui-sans-serif", margin: "0 0 12px" }}>
          来源徽标折行（InteractionRequestOriginBadge）
        </h2>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
          <DialogHeaderPreview width={390} mode="permission" />
          <DialogHeaderPreview width={640} mode="permission" />
          <DialogHeaderPreview width={390} mode="elicitation" />
          <DialogHeaderPreview width={640} mode="elicitation" />
        </div>
      </div>

      <div data-evidence-section="agent-icon" style={{ marginTop: 36, maxWidth: 760 }}>
        <h2 style={{ font: "600 15px/1.4 ui-sans-serif", margin: "0 0 12px" }}>
          NIBI Agent 图标（设置导入 / 代理设置行）
        </h2>
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            background: "#ffffff",
            padding: 12,
          }}
        >
          <div className="flex w-full items-center gap-3 rounded-lg p-3 text-left">
            <div className="flex size-5 shrink-0 items-center justify-center">
              <div className="flex size-4 items-center justify-center rounded-sm border border-border bg-primary text-primary-foreground">
                <span className="text-[10px] leading-none">✓</span>
              </div>
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <img
                src={nibiBirdIcon}
                alt=""
                aria-hidden
                className="size-4 shrink-0 object-contain"
                style={{ filter: "grayscale(1) brightness(0.74) contrast(1.05)" }}
              />
              <div className="min-w-0 flex-1">
                <div className="text-ui-base font-medium leading-none text-foreground">
                  NIBI Agent
                </div>
              </div>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 16,
              marginTop: 12,
              paddingTop: 12,
              borderTop: "1px solid #e5e7eb",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: 12,
                borderRadius: 8,
                background: "#f8fafc",
              }}
            >
              <img
                src={nibiBirdIcon}
                alt=""
                aria-hidden
                className="size-16 object-contain"
                style={{ filter: "grayscale(1) brightness(0.74) contrast(1.05)" }}
              />
              <span style={{ font: "500 12px/1.4 ui-sans-serif", color: "#334155" }}>
                light · 64px
              </span>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: 12,
                borderRadius: 8,
                background: "#1a1a1a",
              }}
            >
              <img
                src={nibiBirdIcon}
                alt=""
                aria-hidden
                className="size-16 object-contain"
                style={{ filter: "grayscale(1) brightness(1.2) contrast(1.1)" }}
              />
              <span style={{ font: "500 12px/1.4 ui-sans-serif", color: "#e2e8f0" }}>
                dark · 64px
              </span>
            </div>
            <img
              src={nibiBirdIcon}
              alt=""
              aria-hidden
              className="size-4 object-contain"
              style={{ filter: "grayscale(1) brightness(0.74) contrast(1.05)" }}
            />
            <span style={{ font: "500 13px/1.4 ui-sans-serif", color: "#111827" }}>
              16px
            </span>
          </div>
        </div>
      </div>

      <div data-evidence-section="na" style={{ marginTop: 36, maxWidth: 900 }}>
        <h2 style={{ font: "600 15px/1.4 ui-sans-serif", margin: "0 0 12px" }}>
          macOS 字体平滑：Windows 无法真机截图（N/A）
        </h2>
        <div
          style={{
            border: "1px solid #e5e7eb",
            borderRadius: 12,
            background: "#0f172a",
            color: "#e2e8f0",
            padding: 16,
            font: "12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          {fontSmoothingRule}
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("harness root missing");
createRoot(root).render(
  <StrictMode>
    <NibiIntlProvider initialLocale="zh-CN">
      <App />
    </NibiIntlProvider>
  </StrictMode>,
);