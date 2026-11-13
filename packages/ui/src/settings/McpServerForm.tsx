import { useEffect, useMemo, useRef, useState } from "react";
import type { McpSource, NibiMcpServer } from "@nibi/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useNibiIntl } from "@/i18n/IntlProvider.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import type { ConfigWorkspaceTarget } from "@/workspace-config-catalog/index.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";
import { ChevronDown, ChevronUpIcon as ChevronUp, Trash2 } from "lucide-react";
import {
  EMPTY_FORM,
  formToJsonDraft,
  jsonDraftToForm,
  serverToForm,
  type FormState,
  type McpEditorMode,
} from "./mcpSettingsShared.js";
import {
  isMcpFormDraftDirty,
  resolveMcpDraftErrorId,
  validateMcpFormDraft,
  type McpDraftErrors,
  type McpDraftValidation,
} from "./mcpDraftState.js";

function McpFormFieldLabel({ children }: { children: string }) {
  return (
    <label className="mb-1 block text-ui-base font-medium text-foreground-subtle">{children}</label>
  );
}

function McpDraftErrorList({ messageIds, testId }: { messageIds?: string[]; testId: string }) {
  const { intl } = useNibiIntl();
  if (!messageIds?.length) {
    return null;
  }
  return (
    <div className="mt-1 space-y-0.5" role="alert" data-testid={testId}>
      {messageIds.map((messageId, index) => (
        <p key={`${index}:${messageId}`} className="text-ui-base text-destructive">
          {intl.formatMessage({ id: messageId })}
        </p>
      ))}
    </div>
  );
}

function draftErrorIds(messageId: string | undefined): string[] | undefined {
  return messageId ? [messageId] : undefined;
}

function allDraftErrorIds(errors: McpDraftErrors): string[] {
  return Object.values(errors).filter(
    (messageId): messageId is string => typeof messageId === "string" && messageId.length > 0,
  );
}

function McpScopeMenu({
  disabled,
  scopeKey,
  workspaceTabs,
  onChange,
}: {
  disabled: boolean;
  scopeKey: string;
  workspaceTabs: ConfigWorkspaceTarget[];
  onChange: (scopeKey: string) => void;
}) {
  const { intl } = useNibiIntl();
  const scopeLabel = intl.formatMessage({ id: "settings.scope.label" });

  return (
    <label className="flex min-w-0 flex-wrap items-center justify-end gap-2">
      <span className="shrink-0 text-ui-base text-foreground-subtle">{scopeLabel}</span>
      <PluginScopeMenu
        align="end"
        disabled={disabled}
        selectedScopeKey={scopeKey}
        workspaceTabs={workspaceTabs}
        onScopeKeyChange={onChange}
      />
    </label>
  );
}

export function McpServerForm({
  initial,
  editingId,
  editorMode,
  onEditorModeChange,
  onSave,
  onCancel,
  onDelete,
  onDirtyChange,
  scopeKey,
  workspaceTabs,
  onScopeKeyChange,
}: {
  initial?: NibiMcpServer;
  editingId?: string;
  editorMode: McpEditorMode;
  source?: McpSource;
  scopeKey: string;
  workspaceTabs: ConfigWorkspaceTarget[];
  onScopeKeyChange: (scopeKey: string) => void;
  onEditorModeChange: (mode: McpEditorMode) => void;
  onSave: (form: FormState, prevServer?: NibiMcpServer) => void;
  onCancel: () => void;
  onDelete?: (server: NibiMcpServer) => void;
  /** 草稿是否包含未保存修改；分区据此在离开/切换 server 前弹确认。 */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { intl } = useNibiIntl();
  // baseline 在挂载时固定：编辑期间 store 的状态快照会不断重建 server 对象，
  // 若每帧重算 baseline，用户刚输入的内容会被误判成"未修改"或反复重置。
  const [baselineForm] = useState<FormState>(() =>
    initial
      ? serverToForm(initial)
      : {
          ...EMPTY_FORM,
          storageLevel: scopeKey === "user" ? "user" : "workspace",
        },
  );
  const [baselineJsonDraft] = useState<string>(() => formToJsonDraft(baselineForm));
  // 表单与 JSON 编辑器共享同一份草稿：两者都只改本地 state，保存按钮才提交。
  const [form, setForm] = useState<FormState>(baselineForm);
  const [jsonDraft, setJsonDraft] = useState<string>(baselineJsonDraft);
  const [showEnv, setShowEnv] = useState(false);
  const formRef = useRef(form);
  const jsonDraftRef = useRef(jsonDraft);
  const previousEditorModeRef = useRef(editorMode);
  const onDirtyChangeRef = useRef(onDirtyChange);

  onDirtyChangeRef.current = onDirtyChange;

  useEffect(() => {
    formRef.current = form;
  }, [form]);

  useEffect(() => {
    jsonDraftRef.current = jsonDraft;
  }, [jsonDraft]);

  const jsonDraftParse = useMemo((): {
    form: FormState | null;
    errorId: string | null;
  } => {
    if (editorMode !== "json") {
      return { form: null, errorId: null };
    }
    try {
      return { form: jsonDraftToForm(jsonDraft, form), errorId: null };
    } catch (error) {
      return { form: null, errorId: resolveMcpDraftErrorId(error) };
    }
  }, [editorMode, form, jsonDraft]);

  const formValidation = useMemo(() => validateMcpFormDraft(form), [form]);
  const jsonValidation = useMemo((): McpDraftValidation => {
    if (editorMode !== "json") {
      return formValidation;
    }
    if (jsonDraftParse.errorId) {
      return { valid: false, errors: { json: jsonDraftParse.errorId } };
    }
    return jsonDraftParse.form
      ? validateMcpFormDraft(jsonDraftParse.form)
      : { valid: false, errors: {} };
  }, [editorMode, formValidation, jsonDraftParse]);
  const activeValidation = editorMode === "json" ? jsonValidation : formValidation;
  // JSON 模式下 form 只在 Scope 切换等场景更新，JSON 文本才是主草稿；
  // form 模式则忽略可能已过期的 jsonDraft，避免切换 tab 后残留格式差异一直显示未保存。
  const dirty =
    isMcpFormDraftDirty(form, baselineForm) ||
    (editorMode === "json" && jsonDraft !== baselineJsonDraft);
  // 新建表单刚打开时整体都是空的，立即铺红字只会制造噪音；
  // 编辑态直接展示已落盘配置里的问题（例如历史坏 URL），新建态等用户改动后再生效。
  const showValidationErrors = dirty || Boolean(initial);

  useEffect(() => {
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  useEffect(
    () => () => {
      // 表单卸载即草稿丢弃；分区不能在下次打开时继承上一份草稿的 dirty。
      onDirtyChangeRef.current?.(false);
    },
    [],
  );

  useEffect(() => {
    const previousMode = previousEditorModeRef.current;
    if (previousMode === editorMode) {
      return;
    }

    if (editorMode === "json") {
      setJsonDraft(formToJsonDraft(formRef.current));
      previousEditorModeRef.current = editorMode;
      return;
    }

    try {
      const parsedForm = jsonDraftToForm(jsonDraftRef.current, formRef.current);
      setForm(parsedForm);
      previousEditorModeRef.current = editorMode;
    } catch {
      // 解析失败时留在 JSON 模式：实时校验已经把 i18n 错误显示在编辑框下，
      // 这里只回退 tab，避免把用户正在修改的 JSON 草稿替换成旧表单值。
      onEditorModeChange(previousMode);
    }
  }, [editorMode, onEditorModeChange]);

  function update(patch: Partial<FormState>) {
    setForm((prev) => {
      const next = { ...prev, ...patch };
      if (editorMode === "json") {
        setJsonDraft(formToJsonDraft(next));
      }
      return next;
    });
  }

  function handleSaveClick() {
    const targetForm = editorMode === "json" ? jsonDraftParse.form : form;
    if (!targetForm || !validateMcpFormDraft(targetForm).valid) {
      return;
    }
    if (editorMode === "json") {
      setForm(targetForm);
    }
    onSave(targetForm, initial);
  }

  const canSave = activeValidation.valid;
  const visibleErrors: McpDraftErrors = showValidationErrors ? activeValidation.errors : {};
  // env/headers/oauth 收在折叠区里；错误提示放在折叠按钮外，
  // 否则用户收起高级选项后只会看到保存按钮变灰、找不到原因。
  const optionalConfigErrorIds = allDraftErrorIds(
    form.type === "stdio"
      ? { env: visibleErrors.env }
      : { headers: visibleErrors.headers, oauth: visibleErrors.oauth },
  );

  const envToggleLabel =
    form.type === "stdio"
      ? intl.formatMessage({ id: "settings.mcp.form.envOptional" })
      : intl.formatMessage({ id: "settings.mcp.form.headersOptional" });
  const envValue = form.type === "stdio" ? form.env : form.headers;
  const envPlaceholder =
    form.type === "stdio"
      ? '{\n  "MY_API_KEY": "your-key"\n}'
      : '{\n  "Authorization": "Bearer your-token"\n}';
  const updateEnvValue = (value: string) =>
    update(form.type === "stdio" ? { env: value } : { headers: value });
  // Radix Select 不接受空串 value；用 "auto" 作为哨兵值：表单里空串 = 未设置 = auto
  // （配置文件不落多余字段），用户显式选 auto 时同样写回空串。
  const updateProtocolVersion = (value: string) =>
    update({ protocolVersion: value === "auto" ? "" : value });
  const scopeSelect = (
    <McpScopeMenu
      disabled={!!initial}
      scopeKey={scopeKey}
      workspaceTabs={workspaceTabs}
      onChange={(nextScopeKey) => {
        // Scope 只影响保存目标，不属于 JSON 配置本身；直接改 form，
        // 避免 JSON 模式下用 formToJsonDraft 把用户正在编辑的 JSON 文本覆盖掉。
        setForm((prev) => ({
          ...prev,
          storageLevel: nextScopeKey === "user" ? "user" : "workspace",
        }));
        onScopeKeyChange(nextScopeKey);
      }}
    />
  );

  return (
    <div className="space-y-4 rounded-xl border border-border p-4">
      {editorMode === "json" ? (
        <div className="space-y-3">
          <div className="flex justify-end">{scopeSelect}</div>
          <div className="space-y-1.5">
            <McpFormFieldLabel>
              {intl.formatMessage({ id: "settings.mcp.form.fullConfig" })}
            </McpFormFieldLabel>
            <SettingsFormTextarea
              rows={16}
              className="font-mono text-ui-base"
              placeholder={
                '{\n  "my-mcp-server": {\n    "type": "http",\n    "url": "https://example.com/mcp"\n  }\n}'
              }
              aria-invalid={showValidationErrors && !activeValidation.valid}
              value={jsonDraft}
              onChange={(e) => setJsonDraft(e.target.value)}
            />
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.mcp.form.pasteHintPrefix" })}{" "}
              <code>{`{"server-name": {...}}`}</code>{" "}
              {intl.formatMessage({ id: "settings.mcp.form.pasteHintMiddle" })}{" "}
              <code>{`{"mcpServers": {"server-name": {...}}}`}</code>
              {intl.formatMessage({ id: "settings.mcp.form.pasteHintSuffix" })}
            </p>
            <McpDraftErrorList
              messageIds={showValidationErrors ? allDraftErrorIds(activeValidation.errors) : []}
              testId="mcp-server-form-json-mode-error"
            />
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="w-full min-w-0 space-y-1.5 md:w-48">
              <McpFormFieldLabel>
                {intl.formatMessage({ id: "settings.mcp.form.name" })}
              </McpFormFieldLabel>
              <Input
                size="lg"
                placeholder="my-mcp-server"
                value={form.name}
                disabled={!!editingId}
                aria-invalid={Boolean(visibleErrors.name)}
                onChange={(e) => update({ name: e.target.value })}
              />
              <McpDraftErrorList
                messageIds={draftErrorIds(visibleErrors.name)}
                testId="mcp-server-form-name-error"
              />
            </div>
            <div>{scopeSelect}</div>
          </div>

          <div className="space-y-1.5">
            <McpFormFieldLabel>
              {intl.formatMessage({ id: "settings.mcp.form.type" })}
            </McpFormFieldLabel>
            <Select
              value={form.type}
              onValueChange={(v) => update({ type: v as FormState["type"] })}
            >
              <SelectTrigger size="lg" className="w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stdio">
                  {intl.formatMessage({ id: "settings.mcp.form.type.stdio" })}
                </SelectItem>
                <SelectItem value="http">HTTP</SelectItem>
                {/*
                  Streamable HTTP 传输类型未启用。
                  <SelectItem value="streamableHttp">Streamable HTTP</SelectItem>
                */}
                <SelectItem value="sse">
                  {intl.formatMessage({ id: "settings.mcp.form.type.sse" })}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="w-full space-y-1.5 md:w-48">
            <McpFormFieldLabel>
              {intl.formatMessage({ id: "settings.mcp.form.timeoutMs" })}
            </McpFormFieldLabel>
            <Input
              size="lg"
              type="number"
              min={1}
              inputMode="numeric"
              placeholder="30000"
              value={form.timeoutMs}
              aria-invalid={Boolean(visibleErrors.timeoutMs)}
              onChange={(e) => update({ timeoutMs: e.target.value })}
            />
            <McpDraftErrorList
              messageIds={draftErrorIds(visibleErrors.timeoutMs)}
              testId="mcp-server-form-timeout-error"
            />
          </div>

          {/*
            sse 形态不渲染该字段：deprecated SSE transport 固定走 legacy 协商，
            该配置对其无效。
          */}
          {form.type !== "sse" && (
            <div className="w-full space-y-1.5 md:w-48">
              <McpFormFieldLabel>
                {intl.formatMessage({ id: "settings.mcp.form.protocolVersion" })}
              </McpFormFieldLabel>
              <Select value={form.protocolVersion || "auto"} onValueChange={updateProtocolVersion}>
                <SelectTrigger size="lg" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">
                    {intl.formatMessage({ id: "settings.mcp.form.protocolVersion.auto" })}
                  </SelectItem>
                  <SelectItem value="legacy">
                    {intl.formatMessage({ id: "settings.mcp.form.protocolVersion.legacy" })}
                  </SelectItem>
                  {/* 显示名用「v2」，但 value 必须保持协议正式版本号 " "（config/wire 值，不可随文案变）*/}
                  <SelectItem value="2026-07-28">
                    {intl.formatMessage({ id: "settings.mcp.form.protocolVersion.modern" })}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}

          {form.type === "stdio" ? (
            <>
              <div className="space-y-1.5">
                <McpFormFieldLabel>
                  {intl.formatMessage({ id: "settings.mcp.form.command" })}
                </McpFormFieldLabel>
                <Input
                  size="lg"
                  placeholder="npx"
                  value={form.command}
                  aria-invalid={Boolean(visibleErrors.command)}
                  onChange={(e) => update({ command: e.target.value })}
                />
                <McpDraftErrorList
                  messageIds={draftErrorIds(visibleErrors.command)}
                  testId="mcp-server-form-command-error"
                />
              </div>
              <div className="space-y-1.5">
                <McpFormFieldLabel>
                  {intl.formatMessage({ id: "settings.mcp.form.args" })}
                </McpFormFieldLabel>
                <Input
                  size="lg"
                  placeholder="-y @modelcontextprotocol/server-memory"
                  value={form.args}
                  onChange={(e) => update({ args: e.target.value })}
                />
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <McpFormFieldLabel>URL</McpFormFieldLabel>
              <Input
                size="lg"
                placeholder="https://mcp.example.com/mcp"
                value={form.url}
                aria-invalid={Boolean(visibleErrors.url)}
                onChange={(e) => update({ url: e.target.value })}
              />
              <McpDraftErrorList
                messageIds={draftErrorIds(visibleErrors.url)}
                testId="mcp-server-form-url-error"
              />
            </div>
          )}

          <div>
            <button
              type="button"
              className="flex items-center gap-1 text-ui-base text-foreground-subtle hover:text-foreground"
              onClick={() => setShowEnv((v) => !v)}
            >
              {showEnv ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
              {envToggleLabel}
            </button>
            {showEnv && (
              <div className="mt-2 space-y-1.5">
                <SettingsFormTextarea
                  rows={4}
                  className="font-mono text-ui-base"
                  placeholder={envPlaceholder}
                  aria-invalid={Boolean(
                    form.type === "stdio" ? visibleErrors.env : visibleErrors.headers,
                  )}
                  value={envValue}
                  onChange={(e) => updateEnvValue(e.target.value)}
                />
              </div>
            )}
            <McpDraftErrorList
              messageIds={optionalConfigErrorIds}
              testId="mcp-server-form-optional-config-error"
            />
          </div>
        </div>
      )}

      <SettingsFormActions
        leadingAction={
          initial && onDelete ? (
            <Button
              type="button"
              variant="link"
              size="lg"
              className="px-0 text-destructive hover:text-destructive"
              onClick={() => onDelete(initial)}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              {intl.formatMessage({ id: "common.delete" })}
            </Button>
          ) : undefined
        }
      >
        <Button
          size="lg"
          data-testid="mcp-server-form-save"
          disabled={!canSave}
          onClick={handleSaveClick}
        >
          {intl.formatMessage({ id: "common.save" })}
        </Button>
        <Button variant="ghost" size="lg" onClick={onCancel}>
          {intl.formatMessage({ id: "common.cancel" })}
        </Button>
      </SettingsFormActions>
    </div>
  );
}
