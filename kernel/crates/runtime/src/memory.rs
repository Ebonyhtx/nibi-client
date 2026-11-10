//! 项目记忆：会话开关与回合结束后的自动抽取（与 Node `@nibi/core` 的 `memory/` 对齐）。
//!
//! Node 的链路：主回合成功结束后，调度一个后台抽取子代理，把最近的消息整理进
//! `MEMORY.md` 与主题文件；抽取只读历史、只写记忆目录，失败不影响主会话。这里保持同一语义：
//! 每会话串行、最多一个在跑 + 一个最新待跑；跳过“本轮已经直接写过记忆”和“没有足够的用户正文”；
//! 关闭会话时取消在跑任务。
//!
//! 目录由入口按 Node `resolveProjectMemoryRoot` 算好（`cli/memories/projects/<slug>-<hash>/memory`）。

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use futures_util::StreamExt;
use nibi_kernel_api::env::{EnvPath, OperationContext, Origin, WorkspaceRef};
use nibi_kernel_api::env_files::{FileKind, ListDir, ReadText, TextRead};
use nibi_kernel_api::ids::{MessageId, OwnerEpoch, SessionId, ToolUseId};
use nibi_kernel_api::message::{
    AssistantMessage, ContentBlock, Message, ToolResultContent, UserMessage, UserOrigin,
};
use nibi_kernel_api::model::{
    ModelEvent, ModelRequest, QuerySource, RequestOptions, ThinkingConfig, ToolDefinition,
};
use nibi_kernel_api::orchestration::{
    BuiltContext, ContextRequest, InteractionAnswer, InteractionRequest, Interactions,
    OrchestrationError,
};
use nibi_kernel_api::permission::PermissionMode;
use nibi_kernel_api::project_memory::{
    ProjectMemoryScheduler, ProjectMemorySettings, ProjectMemoryTurn,
};
use nibi_kernel_api::tool::{PromptContext, Tool, ToolOutput, ToolProgress, ToolUseContext};
use nibi_kernel_base::Spawner;
use nibi_kernel_query::{QueryParts, api_messages};
use serde_json::Value;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

const EXTRACTION_MAX_TURNS: usize = 5;
const EXTRACTION_MAX_OUTPUT_TOKENS: u32 = 5_000;
const MINIMUM_USER_WORDS: usize = 3;
const MANIFEST_FILE_LIMIT: usize = 200;
const MANIFEST_PREVIEW_LINES: u64 = 30;
const MEMORY_TOOL_NAMES: [&str; 6] = ["Read", "Grep", "Glob", "Write", "Edit", "Bash"];

/// 按会话的记忆开关。默认开启；只有 Host 在会话物化时明确给 `false` 才关闭。
/// `features.memory=false` 时缺省值也是关闭（Node `runtimeConfig.memory.enabled`）。
pub struct MemoryPreferences {
    enabled: Mutex<HashMap<SessionId, bool>>,
    default_enabled: bool,
}

impl Default for MemoryPreferences {
    fn default() -> Self {
        Self {
            enabled: Mutex::default(),
            default_enabled: true,
        }
    }
}

impl MemoryPreferences {
    pub(crate) fn with_default(enabled: bool) -> Self {
        Self {
            enabled: Mutex::default(),
            default_enabled: enabled,
        }
    }

    fn set(&self, session: &SessionId, enabled: bool) {
        self.enabled
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(session.clone(), enabled);
    }

    fn forget(&self, session: &SessionId) {
        self.enabled
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(session);
    }
}

impl ProjectMemorySettings for MemoryPreferences {
    fn enabled(&self, session: &SessionId) -> bool {
        self.enabled
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(session)
            .copied()
            .unwrap_or(self.default_enabled)
    }
}

#[derive(Default)]
struct SessionState {
    cursor: Option<MessageId>,
    running: bool,
    pending: Option<ScheduledTurn>,
    cancel: CancellationToken,
    generation: u64,
}

/// 调度时定下的抽取快照：游标与消息数在排队的这一刻固定，执行时不再读会话状态
/// （在跑期间到达的新回合可能已经推进了游标）。
#[derive(Clone)]
struct ScheduledTurn {
    turn: ProjectMemoryTurn,
    message_count: usize,
}

struct Inner {
    parts: QueryParts,
    prefs: Arc<MemoryPreferences>,
    memory_dir: Option<PathBuf>,
    spawner: Spawner,
    state: Mutex<HashMap<SessionId, SessionState>>,
}

/// 项目记忆抽取器：`LocalKernel` 持有它，会话 actor 在成功回合后调度。
#[derive(Clone)]
pub struct MemoryExtractor {
    inner: Arc<Inner>,
}

impl MemoryExtractor {
    pub fn new(
        parts: QueryParts,
        prefs: Arc<MemoryPreferences>,
        memory_dir: Option<PathBuf>,
        spawner: Spawner,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                parts,
                prefs,
                memory_dir,
                spawner,
                state: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub(crate) fn set_enabled(&self, session: &SessionId, enabled: bool) {
        self.inner.prefs.set(session, enabled);
    }
}

impl ProjectMemoryScheduler for MemoryExtractor {
    fn schedule(&self, turn: ProjectMemoryTurn) {
        self.inner.schedule(turn);
    }

    fn session_closed(&self, session: &SessionId) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(current) = state.remove(session) {
            current.cancel.cancel();
        }
        self.inner.prefs.forget(session);
    }
}

impl Inner {
    fn schedule(self: &Arc<Self>, turn: ProjectMemoryTurn) {
        if !self.prefs.enabled(&turn.session) || self.memory_dir.is_none() {
            return;
        }
        let boundary = turn.messages.last().map(|message| message.id().clone());
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let entry = state.entry(turn.session.clone()).or_default();
        let decision = evaluate_extraction(
            &turn.messages,
            entry.cursor.as_ref(),
            self.memory_dir.as_deref(),
            Path::new(turn.workspace.root.as_str()),
        );
        let message_count = match decision {
            ExtractionDecision::Skip { .. } => {
                entry.cursor = boundary;
                return;
            }
            ExtractionDecision::Run { message_count } => message_count,
        };
        let job = ScheduledTurn {
            turn,
            message_count,
        };
        if entry.running {
            entry.pending = Some(job);
            return;
        }
        entry.running = true;
        entry.generation = entry.generation.wrapping_add(1);
        let generation = entry.generation;
        let cancel = entry.cancel.clone();
        drop(state);
        self.spawn(job, generation, cancel);
    }

    fn spawn(self: &Arc<Self>, job: ScheduledTurn, generation: u64, cancel: CancellationToken) {
        let inner = self.clone();
        self.spawner.spawn("project-memory", async move {
            let session = job.turn.session.clone();
            let boundary = job.turn.messages.last().map(|message| message.id().clone());
            let result = inner.extract(&job.turn, job.message_count, &cancel).await;
            let mut state = inner.state.lock().unwrap_or_else(PoisonError::into_inner);
            let Some(entry) = state.get_mut(&session) else {
                return;
            };
            if entry.generation != generation {
                return;
            }
            entry.running = false;
            if result.is_ok() {
                entry.cursor = boundary;
            } else {
                tracing::warn!(
                    session = %session,
                    error = %result.as_ref().err().map(String::as_str).unwrap_or_default(),
                    "project memory extraction failed"
                );
            }
            let pending = entry.pending.take();
            let next_cancel = entry.cancel.clone();
            if let Some(next) = pending {
                entry.running = true;
                entry.generation = entry.generation.wrapping_add(1);
                let next_generation = entry.generation;
                drop(state);
                inner.spawn(next, next_generation, next_cancel);
            }
        });
    }

    async fn extract(
        &self,
        turn: &ProjectMemoryTurn,
        message_count: usize,
        cancel: &CancellationToken,
    ) -> Result<(), String> {
        if cancel.is_cancelled() || !self.prefs.enabled(&turn.session) {
            return Err("cancelled".to_owned());
        }
        let Some(root) = self.memory_dir.as_deref() else {
            return Ok(());
        };
        let history: Vec<Message> = nibi_kernel_api::history::active(&turn.messages)
            .into_iter()
            .map(|message| message.as_ref().clone())
            .collect();
        if history.is_empty() {
            return Ok(());
        }
        let manifest =
            scan_manifest(self.parts.machine.files().as_ref(), &turn.workspace, root).await;
        let prompt = build_extraction_prompt(message_count, &manifest);
        let mut conversation = history;
        conversation.push(Message::User(UserMessage {
            id: self.parts.ids.message(),
            content: vec![ContentBlock::Text { text: prompt }],
            origin: UserOrigin::Human,
        }));
        let tools = memory_tools(&self.parts, &turn.session);
        let names: Vec<String> = tools.keys().cloned().collect();
        let capabilities = self.parts.model.capabilities(&turn.selection).await;
        let configured = capabilities
            .as_ref()
            .map(|capabilities| capabilities.supports_mid_conversation_system);
        let context_request = ContextRequest {
            session: turn.session.clone(),
            workspace: turn.workspace.clone(),
            agent: None,
            source: QuerySource::MainThread,
            mode: turn.mode,
            tool_names: names.clone(),
            selection: turn.selection.clone(),
            plan_flags: Default::default(),
            capabilities,
            mcp: None,
            default_machine: None,
        };
        let built = self
            .parts
            .context
            .build(context_request, &conversation)
            .await
            .unwrap_or(BuiltContext {
                system: Vec::new(),
                user_context: Vec::new(),
                attachments: Vec::new(),
            });
        let definitions: Vec<ToolDefinition> = tools
            .values()
            .map(|tool| ToolDefinition {
                name: tool.name().to_owned(),
                description: tool.description(&PromptContext {
                    tool_names: names.clone(),
                    mode: PermissionMode::BypassPermissions,
                }),
                input_schema: tool.input_schema(),
                cache_control: None,
            })
            .collect();
        let mut messages = api_messages(conversation.iter(), &turn.selection.model, configured);
        for _ in 0..EXTRACTION_MAX_TURNS {
            if cancel.is_cancelled() {
                return Err("cancelled".to_owned());
            }
            let run = self.parts.ids.run();
            let request = ModelRequest {
                selection: turn.selection.clone(),
                system: built.system.clone(),
                messages,
                tools: definitions.clone(),
                tool_choice: None,
                max_tokens: EXTRACTION_MAX_OUTPUT_TOKENS,
                thinking: Some(ThinkingConfig::Disabled),
                temperature: None,
                betas: Vec::new(),
                source: QuerySource::Side("project_memory_extract".to_owned()),
                options: RequestOptions {
                    session_id: Some(turn.session.clone()),
                    run: Some(run.clone()),
                    ..RequestOptions::default()
                },
            };
            let (content, tool_calls) = stream_response(self, request, cancel).await?;
            if tool_calls.is_empty() {
                return Ok(());
            }
            let assistant_id = self.parts.ids.message();
            let assistant = Message::Assistant(AssistantMessage {
                id: assistant_id.clone(),
                content,
                model: turn.selection.model.clone(),
                stop_reason: Some(nibi_kernel_api::message::StopReason::ToolUse),
                usage: None,
            });
            let mut results = Vec::new();
            for (tool_use_id, name, input) in tool_calls {
                results.push(
                    self.execute_tool(turn, &run, &tool_use_id, &name, input, &tools, cancel)
                        .await,
                );
            }
            let user = Message::User(UserMessage {
                id: self.parts.ids.message(),
                content: results
                    .into_iter()
                    .map(|(id, output)| ContentBlock::ToolResult {
                        tool_use_id: id,
                        content: output.content,
                        is_error: output.is_error,
                    })
                    .collect(),
                origin: UserOrigin::ToolResult {
                    assistant: assistant_id,
                },
            });
            conversation.push(assistant);
            conversation.push(user);
            messages = api_messages(conversation.iter(), &turn.selection.model, configured);
        }
        Ok(())
    }

    async fn execute_tool(
        &self,
        turn: &ProjectMemoryTurn,
        run: &nibi_kernel_api::ids::RunId,
        tool_use_id: &ToolUseId,
        name: &str,
        input: Value,
        tools: &HashMap<String, Arc<dyn Tool>>,
        cancel: &CancellationToken,
    ) -> (ToolUseId, ToolOutput) {
        let Some(tool) = tools.get(name).cloned() else {
            return (
                tool_use_id.clone(),
                error_output(format!("Tool {name} is not available to memory extraction")),
            );
        };
        if let Err(message) = check_tool_policy(
            name,
            &input,
            self.memory_dir.as_deref(),
            Path::new(turn.workspace.root.as_str()),
        ) {
            return (tool_use_id.clone(), error_output(message));
        }
        let (progress, mut receiver) = mpsc::channel::<ToolProgress>(8);
        let drain = tokio::spawn(async move { while receiver.recv().await.is_some() {} });
        let context = ToolUseContext {
            session: turn.session.clone(),
            run: run.clone(),
            tool_use: tool_use_id.clone(),
            agent: None,
            workspace: turn.workspace.clone(),
            mode: PermissionMode::BypassPermissions,
            cancel: cancel.child_token(),
            machine: self.parts.machine.clone(),
            local: self.parts.local.clone(),
            artifacts: self.parts.artifacts.clone(),
            interactions: Arc::new(DenyInteractions),
            operation: OperationContext {
                environment: turn.workspace.environment.clone(),
                generation: self.parts.generation.clone(),
                owner_epoch: OwnerEpoch::LOCAL,
                operation: self.parts.ids.operation(),
                origin: Origin::Agent {
                    session: turn.session.clone(),
                    run: run.clone(),
                },
            },
        };
        let output = match tool.call(input, context, progress).await {
            Ok(output) => output,
            Err(error) => error_output(error.to_string()),
        };
        drain.abort();
        (tool_use_id.clone(), output)
    }
}

fn memory_tools(parts: &QueryParts, session: &SessionId) -> HashMap<String, Arc<dyn Tool>> {
    let mut tools = HashMap::new();
    for name in MEMORY_TOOL_NAMES {
        if let Some(tool) = parts
            .tools
            .find_for(session, name)
            .or_else(|| parts.tools.withheld(name))
        {
            tools.insert(name.to_owned(), tool);
        }
    }
    tools
}

async fn stream_response(
    inner: &Inner,
    request: ModelRequest,
    cancel: &CancellationToken,
) -> Result<(Vec<ContentBlock>, Vec<(ToolUseId, String, Value)>), String> {
    let mut stream = inner.parts.model.stream(request, cancel.child_token());
    let mut blocks: Vec<Option<ContentBlock>> = Vec::new();
    let mut json: HashMap<usize, String> = HashMap::new();
    while let Some(event) = stream.next().await {
        let event = event.map_err(|error| error.to_string())?;
        match event {
            ModelEvent::BlockStart { index, block } => {
                if blocks.len() <= index {
                    blocks.resize_with(index + 1, || None);
                }
                blocks[index] = Some(block);
            }
            ModelEvent::BlockDelta { index, delta } => {
                if blocks.len() <= index {
                    blocks.resize_with(index + 1, || None);
                }
                match (blocks[index].as_mut(), delta) {
                    (
                        Some(ContentBlock::Text { text }),
                        nibi_kernel_api::model::BlockDelta::Text(delta),
                    ) => text.push_str(&delta),
                    (
                        Some(ContentBlock::Thinking { thinking, .. }),
                        nibi_kernel_api::model::BlockDelta::Thinking(delta),
                    ) => thinking.push_str(&delta),
                    (
                        Some(ContentBlock::Thinking { signature, .. }),
                        nibi_kernel_api::model::BlockDelta::Signature(delta),
                    ) => *signature = Some(delta),
                    (
                        Some(ContentBlock::ToolUse { .. }),
                        nibi_kernel_api::model::BlockDelta::InputJson(delta),
                    ) => {
                        json.entry(index).or_default().push_str(&delta);
                    }
                    _ => {}
                }
            }
            ModelEvent::MessageStop => break,
            _ => {}
        }
    }
    let mut content = Vec::new();
    let mut calls = Vec::new();
    for (index, block) in blocks.into_iter().enumerate() {
        let Some(block) = block else {
            continue;
        };
        match block {
            ContentBlock::ToolUse { id, name, input } => {
                let input = json
                    .remove(&index)
                    .and_then(|text| serde_json::from_str(&text).ok())
                    .unwrap_or(input);
                calls.push((id.clone(), name.clone(), input.clone()));
                content.push(ContentBlock::ToolUse { id, name, input });
            }
            other => content.push(other),
        }
    }
    Ok((content, calls))
}

fn error_output(message: String) -> ToolOutput {
    ToolOutput {
        content: vec![ToolResultContent::Text { text: message }],
        is_error: true,
        display: Value::Null,
    }
}

struct DenyInteractions;

#[async_trait]
impl Interactions for DenyInteractions {
    async fn ask(
        &self,
        _session: &SessionId,
        _request: InteractionRequest,
    ) -> Result<InteractionAnswer, OrchestrationError> {
        Err(OrchestrationError::Unsupported {
            what: "memory extraction interactions".to_owned(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ExtractionDecision {
    Run {
        message_count: usize,
    },
    Skip {
        message_count: usize,
        reason: &'static str,
    },
}

fn evaluate_extraction(
    messages: &[Message],
    cursor: Option<&MessageId>,
    memory_root: Option<&Path>,
    workspace_root: &Path,
) -> ExtractionDecision {
    let active: Vec<&Message> = messages.iter().collect();
    let after = after_cursor(&active, cursor);
    let message_count = after.len();
    if contains_direct_memory_write(after.iter().copied(), memory_root, workspace_root) {
        return ExtractionDecision::Skip {
            message_count,
            reason: "direct-memory-write",
        };
    }
    if !contains_eligible_user_prose(after.iter().copied()) {
        return ExtractionDecision::Skip {
            message_count,
            reason: "no-user-prose",
        };
    }
    ExtractionDecision::Run { message_count }
}

fn after_cursor<'a>(messages: &[&'a Message], cursor: Option<&MessageId>) -> Vec<&'a Message> {
    let Some(cursor) = cursor else {
        return messages.to_vec();
    };
    let Some(index) = messages.iter().position(|message| message.id() == cursor) else {
        return messages.to_vec();
    };
    messages[index + 1..].to_vec()
}

fn contains_direct_memory_write<'a>(
    messages: impl IntoIterator<Item = &'a Message>,
    root: Option<&Path>,
    workspace_root: &Path,
) -> bool {
    let Some(root) = root else {
        // 没有记忆目录（关闭/远端）时不会走到抽取；这里按“没有直接写”处理。
        return false;
    };
    for message in messages {
        let Message::Assistant(assistant) = message else {
            continue;
        };
        for block in &assistant.content {
            let ContentBlock::ToolUse { name, input, .. } = block else {
                continue;
            };
            if name != "Write" && name != "Edit" {
                continue;
            }
            if let Some(path) = input.get("file_path").and_then(Value::as_str)
                && contained_markdown(path, root, Some(workspace_root))
            {
                return true;
            }
        }
    }
    false
}

fn contains_eligible_user_prose<'a>(messages: impl IntoIterator<Item = &'a Message>) -> bool {
    for message in messages {
        let Message::User(user) = message else {
            continue;
        };
        if !matches!(user.origin, UserOrigin::Human) {
            continue;
        }
        for block in &user.content {
            if let ContentBlock::Text { text } = block
                && count_words(text) >= MINIMUM_USER_WORDS
            {
                return true;
            }
        }
    }
    false
}

/// Node `countWords` 的空白分词，加上 CJK 字符（Node 对无空格的中文只算 1 个词，自动抽取永远
/// 不触发；这里按字符计，保证中文会话也能触发）。
fn count_words(text: &str) -> usize {
    text.split_whitespace()
        .map(|token| {
            let cjk = token
                .chars()
                .filter(|ch| {
                    matches!(
                        *ch as u32,
                        0x3040..=0x30FF
                            | 0x3400..=0x4DBF
                            | 0x4E00..=0x9FFF
                            | 0xAC00..=0xD7AF
                            | 0xF900..=0xFAFF
                    )
                })
                .count();
            if cjk == 0 { 1 } else { cjk }
        })
        .sum()
}

fn build_extraction_prompt(message_count: usize, manifest: &[ManifestEntry]) -> String {
    let existing = if manifest.is_empty() {
        String::new()
    } else {
        let lines = manifest
            .iter()
            .map(|entry| {
                let kind = entry
                    .memory_type
                    .as_deref()
                    .map(|value| format!("[{value}] "))
                    .unwrap_or_default();
                let description = entry
                    .description
                    .as_deref()
                    .map(|value| format!(": {value}"))
                    .unwrap_or_default();
                format!("- {kind}{}{description}", entry.filename)
            })
            .collect::<Vec<_>>()
            .join("\n");
        format!(
            "\n\n## Existing memory files\n\n{lines}\n\nCheck this list before writing — update an existing file rather than creating a duplicate."
        )
    };
    format!(
        "You are now acting as the memory extraction subagent. Analyze the most recent ~{message_count} messages above and use them to update your persistent memory systems.\n\n\
Available tools: Read, Grep, Glob, read-only Bash (ls/find/cat/stat/wc/head/tail and similar), and Edit/Write for paths inside the memory directory only, and Bash rm with paths inside the memory directory only. All other tools — MCP, Agent, write-capable Bash, etc — will be denied.\n\n\
You have a limited turn budget. Edit requires a prior Read of the same file, so the efficient strategy is: turn 1 — issue all Read calls in parallel for every file you might update; turn 2 — issue all Write/Edit calls in parallel. Do not interleave reads and writes across multiple turns.\n\n\
You MUST only use content from the last ~{message_count} messages to update your persistent memories. Do not waste any turns attempting to investigate or verify that content further — no grepping source files, no reading code to confirm a pattern exists, no git commands.{existing}\n\n\
If nothing is worth saving, output only 'Nothing to save.' Do not explain why.\n\n\
If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry.\n\n\
Apply the memory types, what-not-to-save criteria, and frontmatter format from the Memory section of your system prompt — it is already in your context above."
    )
}

#[derive(Debug, Clone)]
struct ManifestEntry {
    filename: String,
    description: Option<String>,
    memory_type: Option<String>,
    mtime_ms: u64,
}

async fn scan_manifest(
    files: &dyn nibi_kernel_api::machine::Files,
    workspace: &WorkspaceRef,
    root: &Path,
) -> Vec<ManifestEntry> {
    let mut entries = Vec::new();
    scan_dir(files, workspace, root, root, 0, &mut entries).await;
    entries.sort_by(|left, right| right.mtime_ms.cmp(&left.mtime_ms));
    entries.truncate(MANIFEST_FILE_LIMIT);
    entries
}

async fn scan_dir(
    files: &dyn nibi_kernel_api::machine::Files,
    workspace: &WorkspaceRef,
    scan_root: &Path,
    directory: &Path,
    depth: usize,
    out: &mut Vec<ManifestEntry>,
) {
    if depth > 2 || out.len() >= MANIFEST_FILE_LIMIT {
        return;
    }
    let request = ListDir {
        path: EnvPath::new(directory.to_string_lossy()),
    };
    let Ok(entries) = files.list_dir(workspace, request).await else {
        return;
    };
    for entry in entries {
        if out.len() >= MANIFEST_FILE_LIMIT {
            return;
        }
        match entry.kind {
            FileKind::Directory => {
                Box::pin(scan_dir(
                    files,
                    workspace,
                    scan_root,
                    &directory.join(&entry.name),
                    depth + 1,
                    out,
                ))
                .await;
            }
            FileKind::File => {
                if !entry.name.ends_with(".md") || entry.name == "MEMORY.md" {
                    continue;
                }
                let path = directory.join(&entry.name);
                let env_path = EnvPath::new(path.to_string_lossy());
                let stat = files
                    .stat(
                        workspace,
                        nibi_kernel_api::env_files::StatFile {
                            path: env_path.clone(),
                        },
                    )
                    .await
                    .ok()
                    .flatten();
                let preview = files
                    .read_text(
                        workspace,
                        ReadText {
                            path: env_path,
                            start_line: 0,
                            max_lines: Some(MANIFEST_PREVIEW_LINES),
                            max_bytes: Some(64 * 1024),
                        },
                    )
                    .await
                    .ok();
                let content = match preview {
                    Some(TextRead::Text(slice)) => slice.content,
                    _ => String::new(),
                };
                let (description, memory_type) = parse_frontmatter(&content);
                out.push(ManifestEntry {
                    filename: path
                        .strip_prefix(directory)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .replace('\\', "/"),
                    description,
                    memory_type,
                    mtime_ms: stat.map(|stat| stat.mtime_ms).unwrap_or(0),
                });
            }
            FileKind::Other => {}
        }
    }
}

fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let normalized = content
        .strip_prefix('\u{feff}')
        .unwrap_or(content)
        .replace("\r\n", "\n");
    let mut lines = normalized.lines();
    if lines.next() != Some("---") {
        return (None, None);
    }
    let mut description = None;
    let mut memory_type = None;
    let mut in_metadata = false;
    for raw in lines {
        if raw == "---" {
            break;
        }
        let trimmed = raw.trim();
        if raw.starts_with("metadata:") {
            in_metadata = true;
            continue;
        }
        // 顶层键（不缩进）结束 metadata 段。
        if in_metadata && !raw.starts_with(' ') && !raw.starts_with('\t') && !trimmed.is_empty() {
            in_metadata = false;
        }
        if let Some(value) = trimmed.strip_prefix("description:") {
            let value = value.trim().trim_matches('"').trim_matches('\'');
            if !value.is_empty() {
                description = Some(value.to_owned());
            }
            continue;
        }
        if let Some(value) = trimmed.strip_prefix("type:") {
            let value = value.trim().trim_matches('"').trim_matches('\'');
            if !value.is_empty() {
                memory_type = Some(value.to_owned());
            }
        }
    }
    (description, memory_type)
}

fn check_tool_policy(
    name: &str,
    input: &Value,
    memory_root: Option<&Path>,
    workspace_root: &Path,
) -> Result<(), String> {
    match name {
        "Read" | "Grep" | "Glob" => Ok(()),
        "Write" | "Edit" => {
            let Some(root) = memory_root else {
                return Err("Memory extraction is not available".to_owned());
            };
            let Some(path) = input.get("file_path").and_then(Value::as_str) else {
                return Err("file_path is required".to_owned());
            };
            if contained_markdown(path, root, Some(workspace_root)) {
                Ok(())
            } else {
                Err(format!(
                    "Memory extraction can only write .md files inside {root:?}"
                ))
            }
        }
        "Bash" => {
            let Some(root) = memory_root else {
                return Err("Memory extraction is not available".to_owned());
            };
            let Some(command) = input.get("command").and_then(Value::as_str) else {
                return Err("command is required".to_owned());
            };
            if nibi_kernel_policy::readonly::is_read_only(command, false)
                || contained_rm(command, root)
            {
                Ok(())
            } else {
                Err("Memory extraction only allows read-only Bash or rm of .md files inside the memory directory".to_owned())
            }
        }
        _ => Err(format!("Tool {name} is not available to memory extraction")),
    }
}

fn contained_markdown(path: &str, root: &Path, cwd: Option<&Path>) -> bool {
    let candidate = Path::new(path);
    let candidate = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else if let Some(cwd) = cwd {
        cwd.join(candidate)
    } else {
        return false;
    };
    let Some(extension) = candidate.extension().and_then(|value| value.to_str()) else {
        return false;
    };
    if extension != "md" {
        return false;
    }
    let root = lexical(root);
    let candidate = lexical(&candidate);
    let (root, candidate) = if cfg!(windows) {
        (
            root.to_string_lossy().to_lowercase(),
            candidate.to_string_lossy().to_lowercase(),
        )
    } else {
        (
            root.to_string_lossy().into_owned(),
            candidate.to_string_lossy().into_owned(),
        )
    };
    candidate == root || candidate.starts_with(&format!("{root}{}", std::path::MAIN_SEPARATOR))
}

fn contained_rm(command: &str, root: &Path) -> bool {
    if command.chars().any(|ch| {
        matches!(
            ch,
            '|' | ';' | '&' | '>' | '<' | '$' | '`' | '*' | '?' | '['
        )
    }) {
        return false;
    }
    let tokens: Vec<&str> = command.split_whitespace().collect();
    if tokens.first() != Some(&"rm") {
        return false;
    }
    let mut paths = 0;
    for token in &tokens[1..] {
        if *token == "--" {
            continue;
        }
        if token.starts_with('-') {
            if token.contains('r') || token.contains('R') {
                return false;
            }
            continue;
        }
        if !token.ends_with(".md") || !Path::new(token).is_absolute() {
            return false;
        }
        if !contained_markdown(token, root, None) {
            return false;
        }
        paths += 1;
    }
    paths > 0
}

fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                out.push(component.as_os_str());
            }
        }
    }
    out
}

#[cfg(test)]
#[path = "memory_tests.rs"]
mod tests;
