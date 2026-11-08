//! 真实终端：进入 alternate screen、读 crossterm 的事件流、用 OSC 52 复制（F25 起按 tmux / screen 包一层）；退出、出错都恢复终端。外部编辑器
//! 运行期间把终端交出去（tui-input.md §4.1）：先丢掉 crossterm 的事件流（它的读线程随之停下，按键留给编辑器），
//! 再恢复终端；收回时反向进行，事件流在下一次读时重建。
use std::io::Write;
use std::pin::Pin;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::{Context, Poll, Waker};

use anyhow::{Result, bail};
use crossterm::event::{Event, EventStream};
use futures_util::{Stream, StreamExt};
use nibi_kernel_api::session_api::Kernel;

use super::{Options, Screen, drive};
use crate::ui::console::Console;
use crate::ui::palette::{ColorLevel, Palette};
use crate::ui::terminal::Guard;

/// 输入事件流的开关：交出终端时丢掉 crossterm 的事件流，收回后重建。
#[derive(Default)]
struct Gate {
    state: Mutex<GateState>,
}

#[derive(Default)]
struct GateState {
    paused: bool,
    stream: Option<EventStream>,
    waker: Option<Waker>,
}

impl Gate {
    fn lock(&self) -> std::sync::MutexGuard<'_, GateState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 同步丢掉事件流：之后编辑器启动，crossterm 不会再读走按键。
    fn pause(&self) {
        let mut state = self.lock();
        state.paused = true;
        state.stream = None;
    }

    fn resume(&self) {
        let mut state = self.lock();
        state.paused = false;
        if let Some(waker) = state.waker.take() {
            waker.wake();
        }
    }
}

/// 经 [`Gate`] 读的终端输入。
struct Input(Arc<Gate>);

impl Stream for Input {
    type Item = Event;

    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Event>> {
        let mut state = self.0.lock();
        if state.paused {
            state.waker = Some(cx.waker().clone());
            return Poll::Pending;
        }
        let stream = state.stream.get_or_insert_with(EventStream::new);
        loop {
            match stream.poll_next_unpin(cx) {
                Poll::Ready(Some(Ok(event))) => return Poll::Ready(Some(event)),
                // 读失败的事件跳过（与原来的 `filter_map(ok)` 相同）。
                Poll::Ready(Some(Err(_))) => {}
                Poll::Ready(None) => return Poll::Ready(None),
                Poll::Pending => return Poll::Pending,
            }
        }
    }
}

/// 写到 stdout 的终端副作用。
struct Stdout {
    guard: Guard,
    gate: Arc<Gate>,
    /// 入口给的终端变量：OSC 52 在 tmux / screen 里要包一层（F25）。
    vars: std::collections::BTreeMap<String, String>,
}

impl Screen for Stdout {
    fn keyboard_enhanced(&self) -> bool {
        self.guard.enhanced()
    }

    /// 角落小鸟的像素图：把光标移到目标格，发 Sixel（终端自己缩放到 128×128 的像素网格）；要清掉时
    /// 用空格盖住那几格（Sixel 不落墨的格子保持底色，所以透明处不会盖住正文）。
    fn image(&mut self, image: &crate::ui::logo::Image) {
        use crate::ui::logo::Payload;
        let mut out = std::io::stdout().lock();
        let (column, row) = image.at;
        // 贴图要把光标移到目标格；写完恢复原位（DECSC/DECRC），否则那个位置会留下一个
        // "第二个光标"，打字时终端的光标也会停在小鸟旁边。
        let _ = out.write_all(b"\x1b7");
        match &image.payload {
            Payload::Sixel(bytes) => {
                let _ = write!(out, "\x1b[{};{}H", row + 1, column + 1);
                let _ = out.write_all(bytes.as_bytes());
            }
            Payload::Clear { cols, rows } => {
                // 关掉自动换行再盖空格，免得最后一格把画面顶上去。
                let _ = out.write_all(b"\x1b[?7l");
                let blank = " ".repeat(usize::from(*cols));
                for line in 0..*rows {
                    let _ = write!(out, "\x1b[{};{}H{}", row + 1 + line, column + 1, blank);
                }
                let _ = out.write_all(b"\x1b[?7h");
            }
        }
        let _ = out.write_all(b"\x1b8");
        let _ = out.flush();
    }

    fn cursor_to(&mut self, at: (u16, u16)) {
        let mut out = std::io::stdout().lock();
        let (row, column) = at;
        let _ = write!(out, "[{};{}H", row + 1, column + 1);
        let _ = out.flush();
    }

    fn notify(&mut self, sequence: &str) {
        let mut out = std::io::stdout().lock();
        // 通知失败只影响这一次提醒。
        let _ = out.write_all(sequence.as_bytes());
        let _ = out.flush();
    }

    fn copy(&mut self, text: &str) {
        let sequence = crate::ui::clipboard::osc52(text, &self.vars);
        let mut out = std::io::stdout().lock();
        // 复制失败只影响这一次复制，不影响界面。
        let _ = out.write_all(sequence.as_bytes());
        let _ = out.flush();
    }

    fn suspend(&mut self) {
        self.gate.pause();
        self.guard.suspend();
    }

    fn resume(&mut self) {
        // 收回失败时终端停在交出的状态，下一帧照常画（画面可能错乱，但输入照常）。
        let _ = self.guard.reclaim();
        self.gate.resume();
    }
}

/// `zcode`（不带 `-p`）：全屏终端界面。返回前恢复终端（备用屏、鼠标、粘贴模式、键盘增强）；SessionEnd 还没跑，入口
/// 打印恢复提示之后调用 [`super::Ending::run`]（session-lifecycle.md §3.5）。
pub async fn run(kernel: Arc<dyn Kernel>, options: Options) -> Result<super::Exit> {
    // 不在终端里（stdin 或 stdout 是管道、文件）时读不到按键、也画不了屏幕：立即失败，不进入界面。Git Bash 的 mintty
    // 同样失败（工作线 F71，tui-input.md §9.6）。
    let preference = options
        .services
        .locale
        .map(crate::services::UiLocale::as_str);
    let lang = crate::ui::i18n::resolve(preference, &options.vars);
    if let Some(refusal) = Console::current().refusal(crate::ui::i18n::strings(lang)) {
        bail!("{refusal}");
    }
    let (mut terminal, guard, probed) = crate::ui::terminal::enter()?;
    let palette = Palette::new(
        ColorLevel::detect(&options.vars, options.os),
        probed.background,
    )
    .with_foreground(probed.foreground);
    let gate = Arc::new(Gate::default());
    let input = Input(gate.clone());
    let mut screen = Stdout {
        guard,
        gate,
        vars: options.vars.clone(),
    };
    let result = drive(kernel, options, palette, &mut terminal, &mut screen, input).await;
    // 先恢复终端（`Guard` 的 drop），再把 SessionEnd 交回入口。
    drop(terminal);
    drop(screen);
    result
}
