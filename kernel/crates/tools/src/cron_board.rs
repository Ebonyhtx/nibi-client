//! 定时任务表（docs/specs/rust-cli/tools-more.md §10.3、§10.4、§16、§17）。
//!
//! 任务表是任务的唯一 owner；排队输入的 owner 是会话 actor。actor 在 `select!` 里轮询唤醒流（不另起任务），
//! 空闲时调用 `take_due` 取走到期任务——所以“只在空闲时触发”由 actor 判断，这里不知道会话忙不忙，也不用
//! 计时去同步状态。
//!
//! 三类任务：会话任务（内存，按顶层会话分组，含 ScheduleWakeup 的 loop 唤醒）；持久任务（文件是事实源，
//! 这里是投影，[`crate::cron_durable`]）；loop 的链与 keepalive（[`crate::cron_loop`]）。

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use nibi_kernel_api::clock::Clock;
use nibi_kernel_api::cron::{CronFire, CronFireKind, CronSignals};
use nibi_kernel_api::cron_store::{CronScheduleRule, CronStore, StoredCronTask};
use nibi_kernel_api::ids::SessionId;
use tokio::sync::watch;

use crate::cron_expr::{self, RECURRING_MAX_AGE_MS};
use crate::cron_loop::LoopState;

/// 一个顶层会话最多的任务数（50，计文件里的全部任务加本会话的会话任务）。
pub(crate) const MAX_JOBS: usize = 50;

/// 会话任务的种类：CronCreate 建的，或 ScheduleWakeup 排的 loop 唤醒（`kind: "loop"`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum JobKind {
    Cron,
    Loop,
}

/// 一个会话任务（session cron task）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Job {
    pub(crate) id: String,
    pub(crate) cron: String,
    pub(crate) prompt: String,
    /// 展示用标题（模型按用户原话填写）。
    pub(crate) title: Option<String>,
    pub(crate) recurring: bool,
    pub(crate) created_at: u64,
    pub(crate) kind: JobKind,
    /// 下次触发的 UTC 毫秒；None 表示不会再触发。
    pub(crate) next_fire: Option<u64>,
    /// 有限次任务的最大触发次数。
    pub(crate) max_runs: Option<u32>,
    /// 已触发的调度次数。
    pub(crate) run_count: u32,
    /// 每 N 单位的长间隔规则；None 表示按 `cron` 调度。
    pub(crate) schedule_rule: Option<CronScheduleRule>,
    /// 相对延迟任务的确切触发时刻；None 表示按 `cron` 调度。
    pub(crate) fire_at: Option<u64>,
}

/// 一个顶层会话的持久任务调度状态（任务表、下次触发时间、是否问过错过的任务）。
#[derive(Debug, Default)]
pub(crate) struct Scheduler {
    pub(crate) started: bool,
    pub(crate) closed: bool,
    pub(crate) leader: bool,
    /// 不持锁时下一次探测锁的时间。
    pub(crate) next_probe: Option<u64>,
    /// 持久任务的下次触发时间（第一次看到时算）；None 是不会再触发。
    pub(crate) next_fire: HashMap<String, Option<u64>>,
    pub(crate) missed_asked: HashSet<String>,
    /// 排着的错过提示与它出现的时间。
    pub(crate) missed_notice: Option<(String, u64)>,
}

#[derive(Default)]
pub(crate) struct State {
    pub(crate) jobs: HashMap<SessionId, Vec<Job>>,
    /// 持久任务的投影（cron 合法的项，文件顺序）。
    pub(crate) durable: Vec<StoredCronTask>,
    pub(crate) schedulers: HashMap<SessionId, Scheduler>,
    pub(crate) loops: HashMap<SessionId, LoopState>,
    /// 定时任务是否开启：本进程用过定时任务，或文件里本来就有任务。
    pub(crate) enabled: bool,
}

pub(crate) struct Inner {
    pub(crate) clock: Arc<dyn Clock>,
    /// 持久任务的存储，构造时给出；None 表示这个内核没有持久任务（测试、嵌入），`durable` 按会话任务处理。
    pub(crate) store: Option<Arc<dyn CronStore>>,
    pub(crate) state: Mutex<State>,
    /// 任务表的版本：每次改动加一，唤醒流据此重新计算等待时间。
    pub(crate) version: watch::Sender<u64>,
}

/// 任务表；克隆共享同一份。
#[derive(Clone)]
pub struct CronBoard(pub(crate) Arc<Inner>);

impl CronBoard {
    /// 持久任务的存储在构造时给出（入口给本地的 `LocalCronStore`，tools-more.md §16.2）；没有时 `durable` 当作假。
    ///
    /// 缺陷修复（审查 R1-13）：原来先建任务表、内核建好后再装存储（`OnceLock` + `set_store`），装上之前与之后的
    /// 行为不同，装两次只记警告。现在存储随任务表一起建好，没有“还没接上”的状态。
    pub fn new(clock: Arc<dyn Clock>, store: Option<Arc<dyn CronStore>>) -> Self {
        Self(Arc::new(Inner {
            clock,
            store,
            state: Mutex::default(),
            version: watch::Sender::new(0),
        }))
    }

    /// 交给会话 actor 的唤醒与到期任务来源（`-p` 不接，runtime 传 `NoCron`）。
    pub fn signals(&self) -> Arc<dyn CronSignals> {
        Arc::new(self.clone())
    }

    pub(crate) fn state(&self) -> MutexGuard<'_, State> {
        self.0.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn store(&self) -> Option<Arc<dyn CronStore>> {
        self.0.store.clone()
    }

    pub(crate) fn changed(&self) {
        self.0.version.send_modify(|version| *version += 1);
    }

    pub(crate) fn now_ms(&self) -> u64 {
        self.0.clock.now_ms()
    }

    /// `Clock::utc_offset_minutes` 作为换算本地时间的偏移函数。
    pub(crate) fn offset(&self) -> impl Fn(u64) -> i32 + '_ {
        |at| self.0.clock.utc_offset_minutes(at)
    }

    /// CronCreate / ScheduleWakeup 之后开始持久调度。
    pub(crate) fn enable(&self) {
        let fresh = !std::mem::replace(&mut self.state().enabled, true);
        if fresh {
            self.changed();
        }
    }

    /// 首次触发时间：相对延迟用确切时刻，长间隔规则按锚点推进，其余按 cron 算。
    pub(crate) fn first_fire(
        &self,
        cron: &str,
        schedule_rule: Option<&CronScheduleRule>,
        fire_at: Option<u64>,
        recurring: bool,
        id: &str,
        from: u64,
    ) -> Option<u64> {
        if let Some(at) = fire_at {
            return Some(at);
        }
        if let Some(rule) = schedule_rule {
            return crate::cron_rule::next(rule, from, &self.offset());
        }
        if recurring {
            cron_expr::recurring_next(cron, from, id, &self.offset())
        } else {
            cron_expr::one_shot_next(cron, from, id, &self.offset())
        }
    }

    /// 本会话的会话任务数。
    pub(crate) fn session_count(&self, owner: &SessionId) -> usize {
        self.state().jobs.get(owner).map_or(0, Vec::len)
    }

    /// CronCreate（`durable` 为假）。
    #[cfg(test)]
    pub(crate) fn add(
        &self,
        owner: &SessionId,
        id: String,
        cron: &str,
        prompt: &str,
        recurring: bool,
    ) {
        self.add_with(owner, id, cron, prompt, recurring, None, None, None, None);
    }

    /// CronCreate 的完整形态（标题、次数、长间隔规则、相对延迟）。
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn add_with(
        &self,
        owner: &SessionId,
        id: String,
        cron: &str,
        prompt: &str,
        recurring: bool,
        title: Option<String>,
        max_runs: Option<u32>,
        schedule_rule: Option<CronScheduleRule>,
        fire_at: Option<u64>,
    ) {
        let created_at = self.now_ms();
        let next_fire = self.first_fire(
            cron,
            schedule_rule.as_ref(),
            fire_at,
            recurring,
            &id,
            created_at,
        );
        let job = Job {
            id,
            cron: cron.to_owned(),
            prompt: prompt.to_owned(),
            title,
            recurring,
            created_at,
            kind: JobKind::Cron,
            next_fire,
            max_runs,
            run_count: 0,
            schedule_rule,
            fire_at,
        };
        let mut state = self.state();
        state.jobs.entry(owner.clone()).or_default().push(job);
        state.enabled = true;
        drop(state);
        self.changed();
    }

    pub(crate) fn has_session_job(&self, owner: &SessionId, id: &str) -> bool {
        self.state()
            .jobs
            .get(owner)
            .is_some_and(|jobs| jobs.iter().any(|job| job.id == id))
    }

    /// 删除会话任务；有这一项时返回 true（先扫会话任务）。
    pub(crate) fn delete_session_job(&self, owner: &SessionId, id: &str) -> bool {
        let removed = self.state().jobs.get_mut(owner).is_some_and(|jobs| {
            let before = jobs.len();
            jobs.retain(|job| job.id != id);
            jobs.len() != before
        });
        if removed {
            self.changed();
        }
        removed
    }

    pub(crate) fn session_jobs(&self, owner: &SessionId) -> Vec<Job> {
        self.state().jobs.get(owner).cloned().unwrap_or_default()
    }

    /// 调度器检查里会话任务的部分：到期的按创建顺序取出；循环任务从现在起排下一次，满 7 天的
    /// 循环任务与一次性任务删除。触发了 loop 唤醒时记下“在跑的 tick”（keepalive 用）。
    pub(crate) fn take_session_jobs(&self, owner: &SessionId, now: u64) -> Vec<CronFire> {
        let mut fires = Vec::new();
        let mut loop_prompt = None;
        let mut state = self.state();
        if let Some(list) = state.jobs.get_mut(owner) {
            list.retain_mut(|job| {
                if job.next_fire.is_none_or(|at| now < at) {
                    return true;
                }
                fires.push(CronFire {
                    job: job.id.clone(),
                    prompt: job.prompt.clone(),
                    kind: match job.kind {
                        JobKind::Cron => CronFireKind::Task,
                        JobKind::Loop => CronFireKind::Loop,
                    },
                });
                if job.kind == JobKind::Loop {
                    loop_prompt = Some(job.prompt.clone());
                }
                let run_count = job.run_count.saturating_add(1);
                let maxed = job.max_runs.is_some_and(|max| run_count >= max);
                let exact_one_shot = job.fire_at.is_some();
                let rule = job.schedule_rule.is_some();
                // 长间隔规则不受 7 天到期限制：每 40 天一次的任务在 7 天内永远不会触发。
                let aged = !rule
                    && !exact_one_shot
                    && job.recurring
                    && now.saturating_sub(job.created_at) >= RECURRING_MAX_AGE_MS;
                let expired = exact_one_shot
                    || maxed
                    || aged
                    || (!job.recurring && job.max_runs.is_none() && !rule);
                if expired {
                    return false;
                }
                job.run_count = run_count;
                job.next_fire = self.first_fire(
                    &job.cron,
                    job.schedule_rule.as_ref(),
                    None,
                    job.recurring,
                    &job.id,
                    now,
                );
                true
            });
        }
        if let Some(prompt) = loop_prompt {
            state.loops.entry(owner.clone()).or_default().in_flight = Some(prompt);
        }
        fires
    }
}

#[cfg(test)]
#[path = "cron_board_tests.rs"]
pub(crate) mod tests;
