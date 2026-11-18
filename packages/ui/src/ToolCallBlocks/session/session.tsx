import { BookOpenTextIcon, CheckIcon, CopyIcon } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import type { ToolCallBlockRenderContext } from "@/ToolCallBlocks/shared.js";
import {
  SESSION_STATE_KEYS,
  WAIT_STATUS_KEYS,
  formatUpdatedAt,
  isOutputTruncated,
  isTruncationNotice,
  normalizeSessionToolName,
  readAdmissionStatusKey,
  readCreateStatusKey,
  readCreationStatusKey,
  readDeliveryStatusKey,
  readMutationStatusKey,
  readOpenStatusKey,
  readProjectRef,
  readResult,
  readRows,
  readSendStatusKey,
  readSessionRefId,
  readText,
  shortId,
  summarizeText,
  toRecord,
} from "./sessionModel.js";

const SESSION_TOOL_ICON = <BookOpenTextIcon className="size-4 shrink-0 text-foreground-subtle" />;

export { isSessionToolCallRenderable, isSessionToolName } from "./sessionModel.js";


/** 只读/观察工具与写入工具共用的详情分区；复制反馈只留在本分区。 */
function SessionDetailSection({
  sectionKey,
  label,
  value,
  children,
}: {
  sectionKey: string;
  label: string;
  value?: string;
  children: ReactNode;
}) {
  const { intl } = useNibiIntl();
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const copied = value !== undefined && copiedValue === value;
  const copyLabel = intl.formatMessage({
    id: copied ? "chat.message.copy.copied" : "chat.message.copy",
  });

  return (
    <section
      data-session-section={sectionKey}
      data-testid="session-tool-section"
      className="min-w-0 space-y-2 [&+section]:border-t [&+section]:border-border [&+section]:pt-3"
    >
      <header className="flex min-h-6 items-center justify-between gap-2 text-ui-sm text-foreground-subtle">
        <h4>{label}</h4>
        {value !== undefined ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            aria-label={`${copyLabel} ${label}`}
            title={copyLabel}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value);
                setCopiedValue(value);
                setCopyFailed(false);
              } catch {
                setCopiedValue(null);
                setCopyFailed(true);
              }
            }}
          >
            {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          </Button>
        ) : null}
      </header>
      {copyFailed ? (
        <p role="status" className="text-ui-sm text-destructive">
          {intl.formatMessage({ id: "chat.toolCall.fallback.copyFailed" })}
        </p>
      ) : null}
      <div
        data-session-scroll="true"
        className="max-h-60 min-w-0 overflow-auto text-ui-base text-foreground-subtle"
      >
        {children}
      </div>
    </section>
  );
}

function SessionDetailRows({ rows }: { rows: { label: string; value: string }[] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
      {rows.map((row) => (
        <div className="contents" key={row.label}>
          <dt className="min-w-0 text-foreground-subtlest">{row.label}</dt>
          <dd className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface DetailSection {
  key: string;
  label: string;
  content: ReactNode;
  copy?: string;
}

export function SessionToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl, locale } = useNibiIntl();
  const { toolCall } = context.toolCallNode;
  const rawName = toolCall.toolName ?? toolCall.kind;
  const name = normalizeSessionToolName(rawName);

  const label = useCallback(
    (key: string) => intl.formatMessage({ id: `chat.toolCall.session.${key}` }),
    [intl],
  );

  if (name === null) {
    // resolveRenderer 只会把 8 个声明的名字送进来；这里仍是防御式兜底，
    // 避免未来新增名字时误用别的工具的回执字段。
    return null;
  }

  const input = toRecord(toolCall.input);
  const result = readResult(toolCall);
  const output = toRecord(result);
  // 大结果预算会把 JSON 转成保存提示或截断文本；解析失败不是空结果，必须保留原文。
  const resultText = typeof result === "string" ? readText(result) : undefined;
  const summary = toRecord(output.summary);
  const targetId =
    readSessionRefId(output.session) ??
    readSessionRefId(summary.session) ??
    readText(input.sessionId) ??
    readSessionRefId(input.session);
  const summaryTitle = readText(summary.title);
  const target = summaryTitle ?? (targetId ? shortId(targetId) : undefined);
  const sessions = readRows(output.sessions);
  const operations = readRows(output.operations);
  const inputOperations = readRows(input.operations);

  const failed = toolCall.status === "failed" || Boolean(context.errorText);
  const aborted = failed || toolCall.status === "denied" || toolCall.status === "stopped";
  const running =
    !aborted &&
    (context.isRunning || toolCall.status === "pending" || toolCall.status === "in_progress");

  let statusKey: string | undefined;
  if (aborted) {
    statusKey = failed ? "failed" : toolCall.status === "denied" ? "rejected" : "stopped";
  } else if (running) {
    statusKey =
      name === "ListProjects" ||
      name === "OpenSession" ||
      name === "SetSessionArchived" ||
      name === "SetSessionPinned"
        ? "running"
        : toolCall.status === "pending"
          ? "pending"
          : `${name}.running`;
  } else if (context.isPermissionPreview) {
    // 审批预览尚未执行：没有回执可判定，不能先写一个「结果未知」。
    statusKey = undefined;
  } else if (resultText) {
    statusKey = "textResult";
  } else if (name === "SendToSession") {
    // admission/delivery 是业务回执，工具执行完成不表示目标会话已处理消息。
    statusKey = readSendStatusKey(output);
  } else if (name === "CreateSession") {
    statusKey = readCreateStatusKey(output);
  } else if (name === "ForkSession") {
    statusKey = readMutationStatusKey(output.status);
  } else if (name === "WaitSessions") {
    statusKey = WAIT_STATUS_KEYS[readText(output.status) ?? ""] ?? "unknown";
  } else if (name === "InterruptSession" || name === "RenameSession") {
    statusKey = readMutationStatusKey(output.status);
  } else if (name === "OpenSession") {
    statusKey = readOpenStatusKey(output.status);
  } else if (name === "SetSessionArchived" || name === "SetSessionPinned") {
    statusKey = readMutationStatusKey(output.status);
  }
  const statusText = statusKey === undefined ? undefined : label(statusKey);
  const stateText = (value: unknown): string =>
    label(SESSION_STATE_KEYS[readText(value) ?? ""] ?? "unknown");

  let primary: string | undefined = target;
  if (name === "ListSessions") {
    primary =
      !aborted && Array.isArray(output.sessions)
        ? intl.formatMessage(
            {
              id:
                sessions.length === 1
                  ? "chat.toolCall.session.foundOne"
                  : "chat.toolCall.session.found",
            },
            { count: sessions.length },
          )
        : (readText(input.title) ?? readText(input.query));
  }
  if (name === "WaitSessions") {
    const ids = new Set(
      (operations.length > 0 ? operations.map((row) => toRecord(row.operation)) : inputOperations)
        .map((row) => readSessionRefId(row.session) ?? readText(row.sessionId))
        .filter((value): value is string => value !== undefined),
    );
    primary =
      ids.size === 0
        ? undefined
        : intl.formatMessage(
            {
              id: ids.size === 1 ? "chat.toolCall.session.countOne" : "chat.toolCall.session.count",
            },
            { count: ids.size },
          );
  }
  if (name === "CreateSession") {
    const prompt = readText(input.prompt);
    primary = target ?? (prompt ? summarizeText(prompt) : undefined);
  }
  if (name === "RenameSession") {
    primary = readText(input.title) ?? target;
  }
  if (name === "ListProjects") {
    const projects = readRows(output.projects);
    primary =
      readText(input.query) ??
      readText(projects[0]?.title) ??
      readText(toRecord(projects[0]?.project).projectId);
  }

  const sections: DetailSection[] = [];
  const add = (key: string, sectionLabel: string, content: ReactNode, copy?: string) => {
    sections.push({ key, label: sectionLabel, content, copy });
  };
  const paragraph = (value: string) => (
    <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{value}</p>
  );

  if (name !== "ListSessions" && name !== "WaitSessions" && name !== "ListProjects" && target) {
    add(
      "target",
      label("target"),
      <p title={targetId} className="[overflow-wrap:anywhere]">
        {target}
      </p>,
      target,
    );
  }

  if (name === "ForkSession") {
    const sourceId = readText(input.sessionId) ?? readSessionRefId(input.session);
    if (sourceId !== undefined && sourceId !== targetId) {
      add(
        "source",
        label("source"),
        <p title={sourceId} className="[overflow-wrap:anywhere]">
          {shortId(sourceId)}
        </p>,
        shortId(sourceId),
      );
    }
  }

  const prompt = readText(input.prompt);
  if ((name === "CreateSession" || name === "SendToSession") && prompt !== undefined) {
    add("prompt", label("message"), paragraph(prompt), prompt);
  }

  const requestedTitle = readText(input.title);
  if (name === "RenameSession" && requestedTitle !== undefined) {
    add("title", label("title"), paragraph(requestedTitle), requestedTitle);
  }

  if (name === "WaitSessions") {
    const mode = readText(input.mode);
    if (mode === "any" || mode === "all") {
      add(
        "mode",
        label("mode"),
        <span data-testid="session-tool-mode">
          {intl.formatMessage({
            id:
              mode === "any" ? "chat.toolCall.session.mode.any" : "chat.toolCall.session.mode.all",
          })}
        </span>,
      );
    }
  }

  if (aborted) {
    const error = context.errorText ?? statusText ?? label("failed");
    add("error", label("result"), paragraph(error), error);
  } else if (resultText !== undefined) {
    add("textResult", label("result"), paragraph(resultText), resultText);
  } else if (name === "ListSessions" && Array.isArray(output.sessions)) {
    const visible = sessions.map((row) => {
      const sessionId = readSessionRefId(row.session);
      return {
        title:
          readText(row.title) ??
          (sessionId === undefined ? label("unknownSession") : shortId(sessionId)),
        id: sessionId,
        status: stateText(row.status),
        updatedAt: formatUpdatedAt(locale, row.updatedAt),
      };
    });
    add(
      "sessions",
      label("sessions"),
      visible.length > 0 ? (
        <ul className="space-y-2" data-testid="session-tool-sessions">
          {visible.map((row, index) => (
            <li key={index} className="flex min-w-0 gap-3">
              <span title={row.id} className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {row.title}
                {row.updatedAt !== undefined ? (
                  <span
                    data-session-updated="true"
                    className="ml-2 whitespace-nowrap text-ui-sm text-foreground-subtlest"
                    title={label("updated")}
                  >
                    {row.updatedAt}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-foreground-subtlest">{row.status}</span>
            </li>
          ))}
        </ul>
      ) : (
        paragraph(label("empty"))
      ),
      visible
        .map((row) => [row.title, row.updatedAt, row.status].filter(Boolean).join(" — "))
        .join("\n") || undefined,
    );

    const scope = toRecord(output.searchScope);
    if (
      readRows(scope.unavailableSources).length > 0 ||
      (Array.isArray(scope.scopes) && scope.scopes.length === 0)
    ) {
      add("scope", label("scope"), paragraph(label("partial")));
    }
  } else if (name === "ListProjects" && Array.isArray(output.projects)) {
    const visible = readRows(output.projects).map((row) => {
      const ref = readProjectRef(row.project);
      return {
        title: readText(row.title) ?? (ref.id ? shortId(ref.id) : label("unknownSession")),
        id: ref.id,
        source: ref.source,
      };
    });
    add(
      "projects",
      label("projects"),
      visible.length > 0 ? (
        <ul className="space-y-2" data-testid="session-tool-projects">
          {visible.map((row, index) => (
            <li key={index} className="flex min-w-0 gap-3">
              <span title={row.id} className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                {row.title}
              </span>
              {row.source !== undefined ? (
                <span className="shrink-0 text-foreground-subtlest" title={row.source}>
                  {shortId(row.source)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        paragraph(label("empty"))
      ),
      visible.map((row) => [row.title, row.source].filter(Boolean).join(" — ")).join("\n") ||
        undefined,
    );
    const scope = toRecord(output.searchScope);
    const unavailable = readRows(scope.unavailableSources);
    if (unavailable.length > 0 || (Array.isArray(scope.scopes) && scope.scopes.length === 0)) {
      const reasons = unavailable
        .map((row) => `${readText(row.sourceServerId) ?? "?"}: ${readText(row.reason) ?? ""}`)
        .join("\n");
      add(
        "scope",
        label("scope"),
        <>{paragraph(label("partial"))}{reasons ? paragraph(reasons) : null}</>,
        reasons || undefined,
      );
    }
  } else if (name === "OpenSession" && !running) {
    const openStatus = label(readOpenStatusKey(output.status));
    const uiTarget = readText(output.uiTarget);
    const reason = readText(output.reason);
    const rows = [
      { label: label("status"), value: openStatus },
      ...(uiTarget === undefined ? [] : [{ label: label("target"), value: uiTarget }]),
    ];
    add(
      "result",
      label("result"),
      <>
        <SessionDetailRows rows={rows} />
        {reason !== undefined ? paragraph(reason) : null}
      </>,
      rows.map((row) => `${row.label}: ${row.value}`).join("\n") +
        (reason === undefined ? "" : `\n${reason}`),
    );
  } else if (name === "ReadSession" && output.view === "summary") {
    const summaryStatus = stateText(summary.status);
    const updatedAt = formatUpdatedAt(locale, summary.updatedAt);
    add(
      "summary",
      label("result"),
      <SessionDetailRows
        rows={[
          { label: label("status"), value: summaryStatus },
          ...(updatedAt === undefined ? [] : [{ label: label("updated"), value: updatedAt }]),
        ]}
      />,
      [summaryStatus, updatedAt].filter(Boolean).join(" — "),
    );
  } else if (
    name === "ReadSession" &&
    output.view === "messages" &&
    Array.isArray(output.messages)
  ) {
    const messages = readRows(output.messages).filter((row) => typeof row.text === "string");
    const roleLabel = (value: unknown): string => {
      const role = readText(value);
      if (role === "user" || role === "assistant" || role === "system" || role === "tool") {
        return intl.formatMessage({ id: `chat.toolCall.session.role.${role}` });
      }
      return label("message");
    };
    add(
      "messages",
      label("messages"),
      messages.length > 0 ? (
        <div className="space-y-3" data-testid="session-tool-messages">
          {messages.map((row, index) => (
            <div key={index} className="space-y-1">
              <p className="text-ui-sm text-foreground-subtlest">{roleLabel(row.role)}</p>
              {paragraph(row.text as string)}
            </div>
          ))}
        </div>
      ) : (
        paragraph(label("noMessages"))
      ),
      messages.map((row) => `${roleLabel(row.role)}\n${row.text}`).join("\n\n") || undefined,
    );
  } else if (name === "CreateSession" && !running) {
    const rows = (
      [
        ["creation", output.creation, readCreationStatusKey],
        ["firstInput", output.firstInput, readAdmissionStatusKey],
        ["delivery", output.delivery, readDeliveryStatusKey],
      ] as const
    )
      .filter(([, value]) => readText(value) !== undefined)
      .map(([key, value, readStatus]) => ({
        label: label(key),
        value: label(readStatus(value)),
      }));
    const reason = readText(output.reason);
    const copy = [
      ...rows.map((row) => `${row.label}: ${row.value}`),
      ...(reason === undefined ? [] : [reason]),
    ].join("\n");
    add(
      "result",
      label("result"),
      <>
        {rows.length > 0 ? (
          <SessionDetailRows rows={rows} />
        ) : (
          paragraph(statusText ?? label("noResult"))
        )}
        {reason !== undefined ? paragraph(reason) : null}
      </>,
      copy || undefined,
    );
  } else if (name === "ForkSession" && !running) {
    const forkStatus = label(readMutationStatusKey(output.status));
    const reason = readText(output.reason);
    const copy = [forkStatus, reason].filter(Boolean).join("\n");
    add(
      "result",
      label("result"),
      <>
        {paragraph(forkStatus)}
        {reason !== undefined ? paragraph(reason) : null}
      </>,
      copy,
    );
  } else if (name === "SendToSession" && !running) {
    const rows = (
      [
        ["admission", output.admission, readAdmissionStatusKey],
        ["delivery", output.delivery, readDeliveryStatusKey],
      ] as const
    )
      .filter(([, value]) => readText(value) !== undefined)
      .map(([key, value, readStatus]) => ({
        label: label(key),
        value: label(readStatus(value)),
      }));
    const reason = readText(output.reason);
    const copy = [
      ...rows.map((row) => `${row.label}: ${row.value}`),
      ...(reason === undefined ? [] : [reason]),
    ].join("\n");
    add(
      "result",
      label("result"),
      <>
        {rows.length > 0 ? (
          <SessionDetailRows rows={rows} />
        ) : (
          paragraph(statusText ?? label("noResult"))
        )}
        {reason !== undefined ? paragraph(reason) : null}
      </>,
      copy || undefined,
    );
  } else if (name === "WaitSessions" && (operations.length > 0 || inputOperations.length > 0)) {
    const entries =
      operations.length > 0
        ? operations.map((row) => ({
            id: readSessionRefId(toRecord(row.operation).session),
            state: stateText(row.status),
            reason: readText(row.reason),
            attention:
              readText(toRecord(row.attention).message) ??
              (readText(toRecord(row.attention).kind) === "approval"
                ? label("attentionApproval")
                : readText(toRecord(row.attention).kind) === "question"
                  ? label("attentionQuestion")
                  : undefined),
          }))
        : inputOperations.map((row) => ({
            id: readSessionRefId(row.session) ?? readText(row.sessionId),
            state: label("pending"),
            reason: undefined,
            attention: undefined,
          }));
    add(
      "operations",
      label("sessions"),
      <ul className="space-y-3" data-testid="session-tool-operations">
        {entries.map((row, index) => (
          <li key={index} className="space-y-1">
            <div className="flex min-w-0 gap-3">
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]" title={row.id}>
                {row.id ? shortId(row.id) : label("unknownSession")}
              </span>
              <span className="shrink-0 text-foreground-subtlest">{row.state}</span>
            </div>
            {row.reason !== undefined ? paragraph(row.reason) : null}
            {row.attention !== undefined ? paragraph(row.attention) : null}
          </li>
        ))}
      </ul>,
      entries
        .map((row) =>
          [row.id ? shortId(row.id) : label("unknownSession"), row.state, row.reason, row.attention]
            .filter(Boolean)
            .join("\n"),
        )
        .join("\n\n"),
    );
    if (!running) {
      add("waitResult", label("result"), paragraph(statusText ?? label("unknown")));
    }
  } else if (name === "WaitSessions") {
    // operation 列表缺席时仍按 wait 回执给结论；运行中只表达还在等待，
    // 不把「没有 operation 行」误读成「没有结果」。
    add(
      "waitResult",
      label("result"),
      paragraph(running ? label("waitingResult") : (statusText ?? label("unknown"))),
    );
  } else if (
    (name === "InterruptSession" || name === "RenameSession") &&
    !running
  ) {
    const mutationStatus = label(readMutationStatusKey(output.status));
    const reason = readText(output.reason);
    const copy = [mutationStatus, reason].filter(Boolean).join("\n");
    add(
      "result",
      label("result"),
      <>
        {paragraph(mutationStatus)}
        {reason !== undefined ? paragraph(reason) : null}
      </>,
      copy,
    );
  } else if (name === "SetSessionArchived" || name === "SetSessionPinned") {
    if (running) {
      add("empty", label("result"), paragraph(label("waitingResult")));
    } else {
      const mutationStatus = label(readMutationStatusKey(output.status));
      const reason = readText(output.reason);
      const requested =
        name === "SetSessionArchived" ? String(input.archived) : String(input.pinned);
      const copy = [requested, mutationStatus, reason].filter(Boolean).join("\n");
      add(
        "result",
        label("result"),
        <>
          {paragraph(mutationStatus)}
          {reason !== undefined ? paragraph(reason) : null}
        </>,
        copy,
      );
    }
  } else if (name === "InterruptSession" || name === "RenameSession") {
    add("empty", label("result"), paragraph(running ? label("waitingResult") : label("noResult")));
  }

  if (!aborted && readText(output.nextCursor) !== undefined) {
    add("more", label("result"), paragraph(label("more")));
  }

  const truncated = isOutputTruncated(toolCall) || isTruncationNotice(resultText);
  if (!aborted && truncated) {
    add(
      "truncated",
      label("truncation"),
      <p data-testid="session-tool-truncated" className="text-ui-sm text-foreground-subtlest">
        {label("truncated")}
      </p>,
    );
  }

  const renderContent = useCallback(
    () => (
      <>
        {context.isPermissionPreview ? null : (
          <div
            data-session-details="true"
            data-testid="session-tool-details"
            className="min-w-0 space-y-3 rounded-xl border border-border bg-surface/40 p-3"
          >
            {sections.map((section) => (
              <SessionDetailSection
                key={section.key}
                sectionKey={section.key}
                label={section.label}
                value={section.copy}
              >
                {section.content}
              </SessionDetailSection>
            ))}
          </div>
        )}
        <ToolSnapshotFieldNotice
          refs={toolCall.snapshotRefs ?? []}
          onLoadFullToolCallFields={
            context.onLoadFullToolCallFields
              ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
              : undefined
          }
        />
      </>
    ),
    [context, sections, toolCall.snapshotRefs, toolCall.toolId],
  );

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={SESSION_TOOL_ICON}
      showIcon={context.showIcon !== false}
      canToggle={context.canToggle ?? true}
      forceOpen={context.forceOpen ?? false}
      kindLabel={label(name)}
      sourceLabel={context.sourceLabel}
      primaryText={primary}
      statusLabel={statusText}
      showStatusLabel={statusText !== undefined}
      showFailureStatus={failed}
      statusTooltip={failed ? context.errorText : undefined}
      isRunning={running}
      title={targetId ?? primary}
      disableSummaryContentAnimation={context.disableSummaryContentAnimation}
      renderContent={renderContent}
    />
  );
}
