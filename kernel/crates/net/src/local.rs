//! 本机 IPC 的监听端与连接端（Unix 域套接字 / Windows 命名管道）。
//!
//! 与 [`crate::uds`] 的区别：`uds` 是跨会话收件箱的 NDJSON 传输；这里只提供“本地 socket 的
//! listener / client stream”，帧的含义由调用方决定（`node_repl` 的浏览器 broker）。
//! 网络类别只由本 crate 打开（README §4），所以 `tokio::net` 的调用集中在这里。

use std::io;

/// 监听端：Unix 是 `UnixListener`，Windows 是命名管道的一个实例。
pub struct LocalListener {
    #[cfg(unix)]
    inner: tokio::net::UnixListener,
    #[cfg(windows)]
    server: tokio::net::windows::named_pipe::NamedPipeServer,
    #[cfg(windows)]
    path: String,
}

/// 服务端接到的连接流。
#[cfg(unix)]
pub type LocalServerStream = tokio::net::UnixStream;
#[cfg(windows)]
pub type LocalServerStream = tokio::net::windows::named_pipe::NamedPipeServer;

/// 客户端连接流。
#[cfg(unix)]
pub type LocalClientStream = tokio::net::UnixStream;
#[cfg(windows)]
pub type LocalClientStream = tokio::net::windows::named_pipe::NamedPipeClient;

impl LocalListener {
    /// 在 `path` 上监听。Unix 路径已有文件时报 `AddrInUse`；Windows 的管道名按 `\\.\pipe\...`。
    #[expect(
        clippy::disallowed_methods,
        reason = "net is the socket entry (README §4): local IPC for the node_repl browser broker"
    )]
    pub fn bind(path: &str) -> io::Result<Self> {
        #[cfg(unix)]
        {
            Ok(Self {
                inner: tokio::net::UnixListener::bind(path)?,
            })
        }
        #[cfg(windows)]
        {
            use tokio::net::windows::named_pipe::ServerOptions;
            Ok(Self {
                server: ServerOptions::new().first_pipe_instance(true).create(path)?,
                path: path.to_owned(),
            })
        }
    }

    /// 接受一个连接。Windows 在交出当前实例后立刻建下一个实例，保证下一个客户端能连上。
    #[expect(
        clippy::disallowed_methods,
        reason = "net is the socket entry (README §4): local IPC for the node_repl browser broker"
    )]
    pub async fn accept(&mut self) -> io::Result<LocalServerStream> {
        #[cfg(unix)]
        {
            let (stream, _) = self.inner.accept().await?;
            Ok(stream)
        }
        #[cfg(windows)]
        {
            use tokio::net::windows::named_pipe::ServerOptions;
            self.server.connect().await?;
            let next = ServerOptions::new().create(&self.path)?;
            Ok(std::mem::replace(&mut self.server, next))
        }
    }
}

/// 连接一个本地 socket。
#[expect(
    clippy::disallowed_methods,
    reason = "net is the socket entry (README §4): local IPC for the node_repl browser broker"
)]
pub async fn connect(path: &str) -> io::Result<LocalClientStream> {
    #[cfg(unix)]
    {
        tokio::net::UnixStream::connect(path).await
    }
    #[cfg(windows)]
    {
        use tokio::net::windows::named_pipe::ClientOptions;
        ClientOptions::new().open(path)
    }
}
