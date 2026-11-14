//! Android / 进程内内核的稳定 C ABI（NIBI-GO Phase C，D19）。
//!
//! Host 在加载页面前设置好进程环境（`HOME`、`NIBI_*`、cwd）后调用
//! `nibi_app_server_start`；内核在独立线程里跑与 `app-server --stdio` 相同的协议前端。
//! 输入用 `nibi_app_server_send` 逐行送入（缺 LF 会补），输出经回调按块送出，块内可能
//! 包含多行 JSON；宿主按 LF 切帧。停止用 `nibi_app_server_stop`，释放用
//! `nibi_app_server_destroy`。
//!
//! 这是刻意最小化的 C ABI：不做 JNI、不做 Android 宿主代码，符号在 cdylib 里导出，
//! GO 侧用自己的 JNI 薄层包。
#![allow(unsafe_code)]

use std::ffi::{CString, c_char, c_void};

use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};
use tokio_util::sync::CancellationToken;

use crate::app_server::{self, Parsed};
use crate::signals::Stop;

pub type NibiAppServerOutputCallback = extern "C" fn(*const u8, usize, *mut c_void);
pub type NibiAppServerErrorCallback = extern "C" fn(*const c_char, *mut c_void);

/// ABI 版本；宿主可先查它再接受符号布局。
pub const NIBI_APP_SERVER_ABI_VERSION: u32 = 1;

pub struct NibiAppServerHandle {
    stop: CancellationToken,
    input: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl NibiAppServerHandle {
    fn stop(&self) {
        self.stop.cancel();
    }
}

fn report_error(callback: Option<NibiAppServerErrorCallback>, user_data: usize, message: &str) {
    let Some(callback) = callback else {
        return;
    };
    let sanitized = message.replace('\0', " ");
    if let Ok(text) = CString::new(sanitized) {
        callback(text.as_ptr(), user_data as *mut c_void);
    }
}

fn run_bridge(
    mut input_rx: tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    stop: CancellationToken,
    output: Option<NibiAppServerOutputCallback>,
    output_user_data: usize,
    error: Option<NibiAppServerErrorCallback>,
    error_user_data: usize,
) {
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(cause) => {
            report_error(
                error,
                error_user_data,
                &format!("cannot start the kernel runtime: {cause}"),
            );
            return;
        }
    };

    runtime.block_on(async move {
        let (server_io, host_io) = tokio::io::duplex(256 * 1024);
        let (server_read, server_write) = tokio::io::split(server_io);
        let (mut host_read, mut host_write) = tokio::io::split(host_io);

        let output_task = tokio::spawn(async move {
            let mut buffer = vec![0_u8; 64 * 1024];
            loop {
                match host_read.read(&mut buffer).await {
                    Ok(0) => break,
                    Ok(n) => {
                        if let Some(callback) = output {
                            callback(buffer.as_ptr(), n, output_user_data as *mut c_void);
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        let input_task = tokio::spawn(async move {
            while let Some(mut bytes) = input_rx.recv().await {
                if bytes.last() != Some(&b'\n') {
                    bytes.push(b'\n');
                }
                if host_write.write_all(&bytes).await.is_err() {
                    break;
                }
                if host_write.flush().await.is_err() {
                    break;
                }
            }
        });

        let parsed = Parsed {
            surface: Some("android".to_owned()),
            prepare_storage: false,
        };
        let stop = Stop::manual(stop);
        let result =
            app_server::run_with_io(parsed, BufReader::new(server_read), server_write, &stop).await;
        if let Err(cause) = result {
            report_error(
                error,
                error_user_data,
                &format!("kernel app-server stopped with an error: {cause:#}"),
            );
        }

        output_task.abort();
        input_task.abort();
    });
}

/// 启动进程内 app-server。返回 NULL 表示线程/运行时没能启动；后续错误走 `error` 回调。
///
/// 宿主必须先设置 `HOME`/`NIBI_*` 与工作目录；内核在启动时读取一次进程环境，和可执行
/// 文件 `app-server --stdio` 是同一套入口。
#[unsafe(no_mangle)]
pub extern "C" fn nibi_app_server_start(
    output: Option<NibiAppServerOutputCallback>,
    output_user_data: *mut c_void,
    error: Option<NibiAppServerErrorCallback>,
    error_user_data: *mut c_void,
) -> *mut NibiAppServerHandle {
    let (input_tx, input_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let stop = CancellationToken::new();
    let thread_stop = stop.clone();
    let output_user_data = output_user_data as usize;
    let error_user_data = error_user_data as usize;
    let thread = match std::thread::Builder::new()
        .name("nibi-app-server".to_owned())
        .spawn(move || {
            run_bridge(
                input_rx,
                thread_stop,
                output,
                output_user_data,
                error,
                error_user_data,
            );
        }) {
        Ok(thread) => thread,
        Err(cause) => {
            report_error(
                error,
                error_user_data,
                &format!("cannot start the kernel thread: {cause}"),
            );
            return std::ptr::null_mut();
        }
    };
    Box::into_raw(Box::new(NibiAppServerHandle {
        stop,
        input: input_tx,
        thread: Some(thread),
    }))
}

/// 送入一行 Host -> kernel 帧。缺 LF 会补；返回 0 成功、-1 参数无效、-2 内核已停止。
#[unsafe(no_mangle)]
pub extern "C" fn nibi_app_server_send(
    handle: *mut NibiAppServerHandle,
    data: *const u8,
    len: usize,
) -> i32 {
    if handle.is_null() || (data.is_null() && len > 0) {
        return -1;
    }
    let bytes = if len == 0 {
        Vec::new()
    } else {
        // SAFETY: 调用方按 C ABI 保证 `data` 至少有 `len` 字节可读；这里立即复制，不保留借用。
        unsafe { std::slice::from_raw_parts(data, len) }.to_vec()
    };
    // SAFETY: `handle` 由本库的 start 返回，且在 destroy 前保持有效。
    let handle = unsafe { &*handle };
    if handle.input.send(bytes).is_err() {
        return -2;
    }
    0
}

/// 取消内核循环；`destroy` 会等待线程退出。
#[unsafe(no_mangle)]
pub extern "C" fn nibi_app_server_stop(handle: *mut NibiAppServerHandle) -> i32 {
    if handle.is_null() {
        return -1;
    }
    // SAFETY: `handle` 由本库的 start 返回，且在 destroy 前保持有效。
    unsafe { &*handle }.stop();
    0
}

/// 停止并释放句柄；可重复调用 NULL。
#[unsafe(no_mangle)]
pub extern "C" fn nibi_app_server_destroy(handle: *mut NibiAppServerHandle) {
    if handle.is_null() {
        return;
    }
    // SAFETY: `handle` 由本库的 start 返回，且只在这里回收一次。
    let mut handle = unsafe { Box::from_raw(handle) };
    handle.stop();
    if let Some(thread) = handle.thread.take() {
        let _ = thread.join();
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn nibi_app_server_abi_version() -> u32 {
    NIBI_APP_SERVER_ABI_VERSION
}
