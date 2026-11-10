//! 持久定时任务：文件的投影、每个会话的调度状态、错过的一次性任务（docs/specs/rust-cli/tools-more.md §16）。
//!
//! 唯一事实源是文件（经 [`CronStore`]）；投影只在本进程写完之后、监听产出变化时、工具要读时重读，重读是
//! 幂等的。哪个会话触发哪个任务见 [`belongs`]。

use nibi_kernel_api::cron::{CronFire, CronFireKind};
use nibi_kernel_api::cron_store::{
    CronCreator, CronFiredTask, CronScheduleRule, CronTasksChange, NewCronTask, StoredCronTask,
};
use nibi_kernel_api::ids::SessionId;

use crate::cron_board::{CronBoard, State};
use crate::cron_expr::{self, RECURRING_MAX_AGE_MS};

/// 不持锁的会话探测锁的间隔。
pub(crate) const PROBE_INTERVAL_MS: u64 = 5_000;
/// 错过提示的任务 ID（不是文件里的任务）。
pub(crate) const MISSED_JOB: &str = "missed";

/// 持久任务是否由会话 `session` 触发（tools-more.md §16.3）。
pub(crate) fn belongs(task: &StoredCronTask, session: &SessionId, leader: bool) -> bool {
    match &task.created_by {
        None => leader,
        Some(creator) if creator == session => true,
        Some(_) if task.creator == CronCreator::ThisProcess => true,
        Some(_) => leader && task.in_project && task.creator == CronCreator::Gone,
    }
}

impl CronBoard {
    /// 从文件重读投影（只留 cron 合法的项），返回投影；读失败时保留原投影。
    pub(crate) async fn read_durable(&self) -> Vec<StoredCronTask> {
        let Some(store) = self.store() else {
            return Vec::new();
        };
        let tasks = match store.tasks().await {
            Ok(tasks) => tasks,
            Err(error) => {
                tracing::warn!(%error, "cannot read scheduled tasks");
                return self.state().durable.clone();
            }
        };
        let valid: Vec<StoredCronTask> = tasks
            .into_iter()
            .filter(|task| {
                let ok = cron_expr::parse(&task.cron).is_some();
                if !ok {
                    tracing::debug!(id = %task.id, cron = %task.cron, "skipping a scheduled task with an invalid cron");
                }
                ok
            })
            .collect();
        let mut state = self.state();
        for scheduler in state.schedulers.values_mut() {
            scheduler
                .next_fire
                .retain(|id, _| valid.iter().any(|task| &task.id == id));
        }
        state.durable = valid.clone();
        drop(state);
        self.changed();
        valid
    }

    async fn change(&self, change: CronTasksChange) -> Result<(), String> {
        let Some(store) = self.store() else {
            return Ok(());
        };
        let result = store
            .change(change)
            .await
            .map_err(|error| error.to_string());
        self.read_durable().await;
        result
    }

    /// CronCreate `durable: true`；没有存储时返回 false，调用方按会话任务处理。
    pub(crate) async fn add_durable(&self, task: NewCronTask) -> Result<bool, String> {
        if self.store().is_none() {
            return Ok(false);
        }
        self.change(CronTasksChange::Add { task }).await?;
        self.enable();
        Ok(true)
    }

    /// CronUpdate：先改会话任务，没有再看文件里的；返回这个 id 是否存在。
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn update(
        &self,
        owner: &SessionId,
        id: &str,
        cron: &str,
        prompt: &str,
        recurring: bool,
        title: Option<String>,
        max_runs: Option<u32>,
        schedule_rule: Option<CronScheduleRule>,
        fire_at: Option<u64>,
    ) -> Result<bool, String> {
        {
            let mut state = self.state();
            if let Some(jobs) = state.jobs.get_mut(owner)
                && let Some(job) = jobs.iter_mut().find(|job| job.id == id)
            {
                job.cron = cron.to_owned();
                job.prompt = prompt.to_owned();
                job.recurring = recurring;
                job.title = title;
                job.max_runs = max_runs;
                job.schedule_rule = schedule_rule;
                job.fire_at = fire_at;
                // 新 cron 从**现在**起算下一次（与创建时同一条规则）。
                let from = self.now_ms();
                job.next_fire = self.first_fire(
                    &job.cron,
                    job.schedule_rule.as_ref(),
                    job.fire_at,
                    recurring,
                    id,
                    from,
                );
                // 版本号与状态锁互不相关（`changed` 只发 watch），持锁调用安全。
                self.changed();
                return Ok(true);
            }
        }
        let known = self.read_durable().await.iter().any(|task| task.id == id);
        if !known {
            return Ok(false);
        }
        self.change(CronTasksChange::Update {
            id: id.to_owned(),
            cron: cron.to_owned(),
            prompt: prompt.to_owned(),
            recurring,
            title,
            max_runs,
            schedule_rule,
            fire_at,
        })
        .await?;
        // 新 cron 从**现在**起算：把持久任务的下一次触发清掉，调度器下一拍按新表达式重算
        // （`read_durable` 是幂等重读，不会自己丢掉已算好的时间）。
        {
            let mut state = self.state();
            for scheduler in state.schedulers.values_mut() {
                scheduler.next_fire.remove(id);
            }
        }
        self.enable();
        self.changed();
        Ok(true)
    }

    /// CronDelete：先删会话任务，没有再删文件里的。
    pub(crate) async fn delete(&self, owner: &SessionId, id: &str) -> Result<(), String> {
        if self.delete_session_job(owner, id) {
            return Ok(());
        }
        self.change(CronTasksChange::Remove {
            ids: vec![id.to_owned()],
        })
        .await
    }

    /// 会话的持久调度开始：抢锁 → 订阅监听 → `Claim` → 读文件 → 错过的一次性
    /// 任务删除并排一条提示。返回监听流。
    pub(crate) async fn start_durable(
        &self,
        session: &SessionId,
    ) -> Option<futures_util::stream::BoxStream<'static, ()>> {
        let store = self.store()?;
        let leader = match store.lead(session).await {
            Ok(leader) => leader,
            Err(error) => {
                tracing::warn!(%error, "cannot take the scheduler lock");
                false
            }
        };
        // 先订阅再读：读完之后的写入都会产出变化。
        let changes = store.changes();
        let claim = CronTasksChange::Claim {
            session: session.clone(),
        };
        if let Err(error) = store.change(claim).await {
            tracing::warn!(%error, "cannot refresh the creator of scheduled tasks");
        }
        let tasks = self.read_durable().await;
        let missed = self.mark_missed(session, leader, tasks);
        if !missed.is_empty()
            && let Err(error) = self.change(CronTasksChange::Remove { ids: missed }).await
        {
            tracing::warn!(%error, "cannot remove missed scheduled tasks");
        }
        self.changed();
        Some(changes)
    }

    /// 记下调度状态（持锁与否）；找出错过的一次性任务（属于本会话、没问过），排一条提示，返回它们的 ID。
    fn mark_missed(
        &self,
        session: &SessionId,
        leader: bool,
        tasks: Vec<StoredCronTask>,
    ) -> Vec<String> {
        let now = self.now_ms();
        let offset = self.offset();
        let mut state = self.state();
        let scheduler = state.schedulers.entry(session.clone()).or_default();
        scheduler.started = true;
        scheduler.leader = leader;
        scheduler.next_probe = (!leader).then_some(now + PROBE_INTERVAL_MS);
        let missed: Vec<StoredCronTask> = tasks
            .into_iter()
            .filter(|task| !task.recurring && task.max_runs.is_none())
            .filter(|task| !scheduler.missed_asked.contains(&task.id))
            .filter(|task| belongs(task, session, leader))
            .filter(|task| {
                if let Some(at) = task.fire_at {
                    return at < now;
                }
                // 长间隔规则（每 N 天/月/年）不是「错过的一次性任务」。
                if task.schedule_rule.is_some() {
                    return false;
                }
                cron_expr::next_after(&task.cron, task.created_at, &offset)
                    .is_some_and(|at| at < now)
            })
            .collect();
        for task in &missed {
            scheduler.missed_asked.insert(task.id.clone());
            scheduler.next_fire.insert(task.id.clone(), None);
        }
        if !missed.is_empty() {
            let text = crate::cron_texts::missed(&missed, &offset);
            scheduler.missed_notice = Some((text, now));
        }
        missed.into_iter().map(|task| task.id).collect()
    }

    /// 不持锁的会话到点探测锁；拿到后开始认领无主任务。
    pub(crate) async fn probe(&self, session: &SessionId) {
        let Some(store) = self.store() else {
            return;
        };
        let leader = store.lead(session).await.unwrap_or(false);
        let now = self.now_ms();
        let closed = {
            let mut state = self.state();
            let scheduler = state.schedulers.entry(session.clone()).or_default();
            if !scheduler.closed {
                scheduler.leader = leader;
                scheduler.next_probe = (!leader).then_some(now + PROBE_INTERVAL_MS);
            }
            scheduler.closed
        };
        // 探测的同时会话关了：刚拿到的锁马上放掉。
        if closed && leader {
            let _ = store.release(session).await;
        }
        self.changed();
    }

    /// 会话关闭：停止它的持久调度，释放它的锁。
    pub(crate) async fn close_durable(&self, session: &SessionId) {
        let held = {
            let mut state = self.state();
            let scheduler = state.schedulers.entry(session.clone()).or_default();
            scheduler.closed = true;
            scheduler.next_probe = None;
            std::mem::replace(&mut scheduler.leader, false)
        };
        if held
            && let Some(store) = self.store()
            && let Err(error) = store.release(session).await
        {
            tracing::warn!(%error, "cannot release the scheduler lock");
        }
        self.changed();
    }

    /// 取走到期的持久任务（只在会话空闲时）：循环任务回写 `lastFiredAt`，一次性任务与满 7 天的循环任务删除。
    pub(crate) async fn take_durable(&self, session: &SessionId, now: u64) -> Vec<CronFire> {
        let (fires, fired, removed) = {
            let mut state = self.state();
            due_durable(self, &mut state, session, now)
        };
        if !fired.is_empty() {
            let mark = CronTasksChange::MarkFired { entries: fired };
            if let Err(error) = self.change(mark).await {
                tracing::warn!(%error, "cannot persist lastFiredAt");
            }
        }
        if !removed.is_empty() {
            let remove = CronTasksChange::Remove { ids: removed };
            if let Err(error) = self.change(remove).await {
                tracing::warn!(%error, "cannot remove fired scheduled tasks");
            }
        }
        fires
    }
}

/// 持久任务第一次看到时的触发时间：相对延迟用确切时刻；循环任务从 `lastFiredAt ?? createdAt`，
/// 一次性任务从 `createdAt`。
pub(crate) fn first_sight(board: &CronBoard, task: &StoredCronTask) -> Option<u64> {
    if let Some(at) = task.fire_at {
        return Some(at);
    }
    let from = if task.recurring || task.max_runs.is_some() {
        task.last_fired_at.unwrap_or(task.created_at)
    } else {
        task.created_at
    };
    board.first_fire(
        &task.cron,
        task.schedule_rule.as_ref(),
        None,
        task.recurring,
        &task.id,
        from,
    )
}

type Due = (Vec<CronFire>, Vec<CronFiredTask>, Vec<String>);

fn due_durable(board: &CronBoard, state: &mut State, session: &SessionId, now: u64) -> Due {
    let mut due = (Vec::new(), Vec::new(), Vec::new());
    let State {
        durable,
        schedulers,
        ..
    } = state;
    let Some(scheduler) = schedulers.get_mut(session) else {
        return due;
    };
    if let Some((text, _)) = scheduler.missed_notice.take() {
        due.0.push(CronFire {
            job: MISSED_JOB.to_owned(),
            prompt: text,
            kind: CronFireKind::Notice,
        });
    }
    if !scheduler.started || scheduler.closed {
        return due;
    }
    for task in durable.iter() {
        if !belongs(task, session, scheduler.leader) {
            continue;
        }
        let next = *scheduler
            .next_fire
            .entry(task.id.clone())
            .or_insert_with(|| first_sight(board, task));
        if next.is_none_or(|at| now < at) {
            continue;
        }
        due.0.push(CronFire {
            job: task.id.clone(),
            prompt: task.prompt.clone(),
            kind: CronFireKind::Task,
        });
        let run_count = task.run_count.saturating_add(1);
        let maxed = task.max_runs.is_some_and(|max| run_count >= max);
        let rule = task.schedule_rule.is_some();
        let exact_one_shot = task.fire_at.is_some();
        let aged = !rule
            && !exact_one_shot
            && task.recurring
            && !task.permanent
            && now.saturating_sub(task.created_at) >= RECURRING_MAX_AGE_MS;
        let expired = exact_one_shot
            || maxed
            || aged
            || (!task.recurring && task.max_runs.is_none() && !rule);
        if expired {
            scheduler.next_fire.insert(task.id.clone(), None);
            due.2.push(task.id.clone());
        } else {
            let next = board.first_fire(
                &task.cron,
                task.schedule_rule.as_ref(),
                None,
                task.recurring,
                &task.id,
                now,
            );
            scheduler.next_fire.insert(task.id.clone(), next);
            due.1.push(CronFiredTask {
                id: task.id.clone(),
                at: now,
                run_count,
            });
        }
    }
    due
}

#[cfg(test)]
#[path = "cron_durable_tests.rs"]
mod tests;
