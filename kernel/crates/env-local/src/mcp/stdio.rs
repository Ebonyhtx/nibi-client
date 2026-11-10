//! stdio 传输（docs/specs/rust-cli/ext.md §3.2；MCP SDK `StdioClientTransport`）：服务器进程经账本启动
//! （`Purpose::Mcp`、`Isolation::Group`、`Containment::ProcessJob`），stdin 一行一条消息，stdout 按行读，
//! 不是 JSON 的行丢弃并记日志，stderr 只进日志。
//!
//! 一个连接任务拥有进程与管道：写 stdin、读 stdout、关闭都在这里，没有共享的锁。
//!
//! 读与写是同一个任务里并发的两半（审查 R1-18）：读的一半在事件通道满时停读 stdout（背压到服务器）；写的
//! 一半在服务器不读 stdin 时停在写入上。两半互不等待，关闭是单独的信号，任何一半卡住都能关。

use std::collections::BTreeMap;
use std::process::Stdio;

use nibi_kernel_api::mcp::{McpError, McpTransportEvent};
use nibi_kernel_proc::ledger::{Containment, Isolation, Ledger, Purpose, Tracked};
use nibi_kernel_proc::tree::Shutdown;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

#[cfg(windows)]
use super::node_fallback;
use super::{EventSender, OUTBOX_CAPACITY};
use crate::shell::environ;

/// 发往一个 stdio 服务器的入口：有界的发件箱与关闭信号。
pub(crate) struct StdioLink {
    outbox: mpsc::Sender<Value>,
    closing: CancellationToken,
    /// 服务器进程的 pid（`process/childProcesses` 的归属来源）。
    pid: u32,
}

impl StdioLink {
    /// 交给连接任务写进 stdin。发件箱满（服务器不读输入）时立即报错，不等待：等待会把调用方（工具调用、读者对
    /// 服务器请求的回答）卡在一个不读输入的服务器上。
    pub(crate) fn send(&self, message: Value) -> Result<(), McpError> {
        self.outbox.try_send(message).map_err(|error| match error {
            mpsc::error::TrySendError::Full(_) => McpError::Io {
                message: format!(
                    "the MCP server is not reading its input ({OUTBOX_CAPACITY} messages are waiting)"
                ),
            },
            mpsc::error::TrySendError::Closed(_) => McpError::Closed {
                message: "the server process has exited".to_owned(),
            },
        })
    }

    pub(crate) fn close(&self) {
        self.closing.cancel();
    }

    pub(crate) fn pid(&self) -> u32 {
        self.pid
    }
}

/// 启动一个 stdio 服务器需要的东西。
pub(crate) struct Launch<'a> {
    pub server: &'a str,
    pub command: &'a str,
    pub args: &'a [String],
    pub env: &'a BTreeMap<String, String>,
    /// 执行器的服务端按客户端实例推来的变量（F96）：投影之后、配置的 `env` 之前。
    pub overrides: &'a nibi_kernel_api::env_command::EnvOverrides,
    pub cwd: &'a str,
    /// 入口捕获的进程环境（按白名单投影）。
    pub snapshot: &'a [(String, String)],
}

/// 服务器进程的环境：快照的白名单投影，再加推来的变量（F96），最后是配置的 `env`（配置写明的优先）。
pub(crate) fn child_env(
    snapshot: &[(String, String)],
    overrides: &nibi_kernel_api::env_command::EnvOverrides,
    configured: &BTreeMap<String, String>,
) -> BTreeMap<String, String> {
    // 修复线 F58：`SHELL` 照快照继承（以前没设时写 `/bin/sh`，不该有这个缺省）。
    let mut env = environ::project(snapshot, None);
    environ::apply(&mut env, overrides);
    env.extend(
        configured
            .iter()
            .map(|(key, value)| (key.clone(), value.clone())),
    );
    env
}

fn spawn_error(server: &str, error: impl std::fmt::Display) -> McpError {
    McpError::Connect {
        message: format!("MCP server \"{server}\" failed to start: {error}"),
    }
}

/// 启动进程与连接任务。
pub(crate) async fn start(
    ledger: &Ledger,
    launch: Launch<'_>,
    events: EventSender,
) -> Result<(std::sync::Arc<StdioLink>, nibi_kernel_base::OwnedTask<()>), McpError> {
    let mut env = child_env(launch.snapshot, launch.overrides, launch.env);
    // Windows 的 CreateProcess 只认 `.exe`：先按 PATH/PATHEXT 解析（用户自己的 node/npm/npx 优先），
    // 再回退到 Host 下发的 Electron Node（docs/design/v2/mcp-node-fallback.md）。
    #[cfg(windows)]
    let mut command = {
        let resolved = node_fallback::resolve(launch.command, launch.args, &env)
            .map_err(|detail| spawn_error(launch.server, detail))?;
        let mut command = nibi_kernel_proc::command(&resolved.program);
        if let Some(raw_arguments) = resolved.raw_arguments {
            // 批处理：参数已经按 cmd.exe 规则拼好，不能再让 CRT 加引号。
            command.raw_arg(raw_arguments);
        } else {
            command.args(&resolved.args);
        }
        for (key, value) in resolved.env {
            // Windows 上环境名不区分大小写：先删掉大小写变体，保证回退变量是子进程实际看到的值。
            env.retain(|existing, _| !existing.eq_ignore_ascii_case(&key));
            env.insert(key, value);
        }
        command
    };
    // 非 Windows 不做任何改写（与以前完全一致）。
    #[cfg(not(windows))]
    let mut command = {
        let mut command = nibi_kernel_proc::command(launch.command);
        command.args(launch.args);
        command
    };
    command
        .current_dir(launch.cwd)
        .env_clear()
        .envs(&env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut tracked = ledger
        .spawn(
            &mut command,
            Purpose::Mcp,
            Isolation::Group,
            Containment::ProcessJob,
        )
        .await
        .map_err(|error| spawn_error(launch.server, &error))?;
    let child = tracked.child();
    let (Some(stdin), Some(stdout), Some(stderr)) =
        (child.stdin.take(), child.stdout.take(), child.stderr.take())
    else {
        return Err(McpError::Connect {
            message: format!("MCP server \"{}\" has no pipes", launch.server),
        });
    };
    let pid = tracked.pid();
    let (outbox, inbox) = mpsc::channel(OUTBOX_CAPACITY);
    let closing = CancellationToken::new();
    let server = launch.server.to_owned();
    let task = nibi_kernel_base::owned(run(Pipes {
        server,
        tracked,
        stdin,
        stdout,
        stderr,
        inbox,
        events,
        closing: closing.clone(),
    }));
    Ok((
        std::sync::Arc::new(StdioLink {
            outbox,
            closing,
            pid,
        }),
        task,
    ))
}

struct Pipes {
    server: String,
    tracked: Tracked,
    stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
    inbox: mpsc::Receiver<Value>,
    events: EventSender,
    closing: CancellationToken,
}

/// 为什么停下。
#[derive(Debug)]
enum Stop {
    Closed,
    Exited,
    WriteFailed(String),
}

/// 一行协议/日志的文本形式：非 UTF-8 按替换字符解码（Node `toString("utf8")` 同口径），
/// 去掉行尾的 `\r\n`。MCP 子进程不一定说 UTF-8（Windows 上的 Python 插件按系统代码页写）。
pub(super) fn decode_line(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).trim_end().to_owned()
}

/// 读的一半：stdout 一行一条消息交给读者，stderr 只进日志。事件通道满时在这里等（背压）；读者已经释放事件流时
/// 继续读、丢掉消息（不让服务器卡在输出上）。stdout 结束即服务器退出。
///
/// 按**字节行**读再 [`decode_line`]：之前用 `lines()` 一遇到非 UTF-8 就把整条连接判成"进程退出"
/// （实测 2026-11-09：数模插件的 Python 桥在 Windows 上写 cp936 的 JSON，面板永远报
/// `MCP App connection is unavailable`）。
async fn read(
    server: &str,
    stdout: tokio::process::ChildStdout,
    stderr: tokio::process::ChildStderr,
    events: &EventSender,
) -> Stop {
    let mut lines = BufReader::new(stdout);
    let mut errors = BufReader::new(stderr);
    let mut line_bytes: Vec<u8> = Vec::new();
    let mut error_bytes: Vec<u8> = Vec::new();
    let mut errors_open = true;
    let mut reader_gone = false;
    loop {
        tokio::select! {
            read = lines.read_until(b'\n', &mut line_bytes) => match read {
                Ok(0) => return Stop::Exited,
                Ok(_) => {
                    let line = decode_line(&line_bytes);
                    line_bytes.clear();
                    if line.is_empty() {
                        continue;
                    }
                    match serde_json::from_str::<Value>(&line) {
                        Ok(message) if !reader_gone => {
                            let event = McpTransportEvent::Message { message };
                            reader_gone = events.send(event).await.is_err();
                        }
                        Ok(_) => {}
                        Err(error) => tracing::debug!(server, %error, "ignored a non-JSON line from an MCP server"),
                    }
                }
                Err(error) => {
                    tracing::debug!(server, %error, "reading MCP server stdout failed");
                    return Stop::Exited;
                }
            },
            read = errors.read_until(b'\n', &mut error_bytes), if errors_open => match read {
                Ok(0) => errors_open = false,
                Ok(_) => {
                    let line = decode_line(&error_bytes);
                    error_bytes.clear();
                    if !line.is_empty() {
                        tracing::debug!(server, line, "MCP server stderr");
                    }
                }
                Err(error) => {
                    tracing::debug!(server, %error, "reading MCP server stderr failed");
                    errors_open = false;
                }
            },
        }
    }
}

/// 写的一半：发件箱里的消息逐条写进 stdin；发件箱的发送端全部释放（连接已移除）时当作关闭。
async fn write(
    server: &str,
    mut stdin: tokio::process::ChildStdin,
    mut inbox: mpsc::Receiver<Value>,
) -> Stop {
    while let Some(message) = inbox.recv().await {
        let mut text = message.to_string();
        text.push('\n');
        if let Err(error) = stdin.write_all(text.as_bytes()).await {
            return Stop::WriteFailed(error.to_string());
        }
        if let Err(error) = stdin.flush().await {
            return Stop::WriteFailed(error.to_string());
        }
    }
    tracing::debug!(server, "MCP server stdin writer finished: the outbox was closed");
    Stop::Closed
}

async fn run(pipes: Pipes) {
    let Pipes {
        server,
        mut tracked,
        stdin,
        stdout,
        stderr,
        inbox,
        events,
        closing,
    } = pipes;
    // 先关 stdin（MCP SDK 关闭时也是先结束输入），再结束进程树：select! 结束时写的一半连同 stdin 一起释放。
    let stop = tokio::select! {
        stop = read(&server, stdout, stderr, &events) => stop,
        stop = write(&server, stdin, inbox) => stop,
        () = closing.cancelled() => Stop::Closed,
    };
    // 进程自己退出时直接收拾残留；主动关闭与写失败时先 TERM 再 KILL。
    let exited = matches!(stop, Stop::Exited);
    // 服务器刚握手就断开时，这一行是唯一能区分「进程自己退了」与「宿主把 stdin 收了」的证据。
    let status = tracked
        .child()
        .try_wait()
        .ok()
        .flatten()
        .map(|status| status.to_string());
    tracing::debug!(server, stop = ?stop, ?status, "MCP server transport stopped");
    let (reason, shutdown) = match stop {
        Stop::Closed => (None, Shutdown::Graceful),
        Stop::Exited => (
            Some(format!("MCP server \"{server}\" process exited")),
            Shutdown::Immediate,
        ),
        Stop::WriteFailed(error) => (
            Some(format!(
                "writing to MCP server \"{server}\" failed: {error}"
            )),
            Shutdown::Graceful,
        ),
    };
    if let Err(error) = tracked.terminate(shutdown).await {
        tracing::warn!(server, %error, "could not confirm the MCP server process tree ended");
    }
    // 读者已经释放事件流时发送失败，忽略。
    let _ = events
        .send(McpTransportEvent::Closed {
            reason,
            session_expired: false,
            // 进程自己退出才是 crash（主动关闭、写失败都不算）。
            exited,
        })
        .await;
}
