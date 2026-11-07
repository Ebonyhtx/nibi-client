//! AskUserQuestion 的自动结束（Node `nibi-protocol-v4/interaction-registry.ts` 的镜像）。
//!
//! 语义逐条对齐 Node 的注册表：
//! - **只有队首计时**：同一会话的交互按提问顺序排队（权限、提问、计划审批都算），队首不是
//!   AskUserQuestion 时后面的问题不起表；
//! - **两段计时**：登记后先 `hiddenGrace`（60 s，界面还不显示进度），到 `visibleAt` 转
//!   `visibleCountdown`（侧栏开始画自动继续的进度环；弹窗只在最后一分钟显示剩余秒数），
//!   到 `deadlineAt`（登记后 300 s）自动应答；
//! - **自动应答**是 v4 的 `action: accept` + `content.answers: {}`，即“用户没给答案但允许继续”，
//!   不是拒绝；
//! - **Snooze 永久**：用户第一次操作这个问题就把倒计时换成 `snoozed`，之后不再起表；
//! - **偏好只影响之后的问题**：关掉时把正在计时的换成 `snoozed` 并返回条数，重新打开不追溯。
//!
//! 状态存在待答交互的 `autoResolution` 字段里（v4 `interactionAutoResolutionSchema`），所以快照、
//! 增量与 `sessions-index` 的侧栏摘要读的是同一份值。资格与在途标记只在内存里：它们决定“要不要
//! 起表”，不上线（Node 的 `autoResolutionEligible` 同样是内存态）。

use std::collections::HashSet;

use serde_json::{Map, Value, json};

/// 登记后到界面开始显示倒计时的宽限（Node `ASK_USER_QUESTION_HIDDEN_GRACE_MS`）。
pub const HIDDEN_GRACE_MS: u64 = 60_000;

/// 登记后到自动应答的绝对期限（Node `ASK_USER_QUESTION_AUTO_RESOLUTION_MS`）。
pub const AUTO_RESOLUTION_MS: u64 = 300_000;

/// 到点要做的一件事。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// `hiddenGrace` → `visibleCountdown`。
    Visible(String),
    /// 到期：发自动应答。
    Resolve(String),
}

/// 自动结束的资格与计时。字段都在 `Projection` 里，跟着会话投影走。
#[derive(Debug, Clone)]
pub struct AutoResolution {
    enabled: bool,
    hidden_grace_ms: u64,
    auto_resolution_ms: u64,
    /// 登记时拿到计时资格、之后没被关掉的交互（Node `autoResolutionEligible`）。
    eligible: HashSet<String>,
    /// 已经发出自动应答、等内核收口的交互：别再重复发，也不再排下一次唤醒。
    in_flight: HashSet<String>,
}

impl AutoResolution {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            hidden_grace_ms: HIDDEN_GRACE_MS,
            auto_resolution_ms: AUTO_RESOLUTION_MS,
            eligible: HashSet::new(),
            in_flight: HashSet::new(),
        }
    }

    /// 测试用：缩短两段计时。
    #[cfg(test)]
    pub fn with_timing(mut self, hidden_grace_ms: u64, auto_resolution_ms: u64) -> Self {
        self.hidden_grace_ms = hidden_grace_ms;
        self.auto_resolution_ms = auto_resolution_ms;
        self
    }

    /// 冷打开的待答问题：它们没有经过 `on_asked`，资格要按当前偏好补上。
    ///
    /// Rust 的存档没有绝对时间（Node 把 `autoResolution` 写进 session entry，重启后按原时间续跑），
    /// 所以冷打开从这里起重置 60 s/300 s。待答交互本来就不跨进程恢复，这只覆盖同进程内重新打开投影。
    pub fn seed(&mut self, pending: &mut [Value], now: u64) -> bool {
        if self.enabled {
            for entry in pending.iter() {
                if is_question_entry(entry)
                    && let Some(id) = entry["interactionId"].as_str()
                {
                    self.eligible.insert(id.to_owned());
                }
            }
        }
        self.activate_head(pending, now)
    }

    /// 新问了一个交互：AskUserQuestion 按当前偏好决定资格，然后看它是不是队首。
    ///
    /// 返回是否起了表（调用方据此决定要不要重发 `pendingInteractions`）。
    pub fn on_asked(&mut self, pending: &mut [Value], interaction: &str, now: u64) -> bool {
        if is_question(pending, interaction) {
            if self.enabled {
                self.eligible.insert(interaction.to_owned());
            } else {
                // 关着的时候问的问题永远不计时（Node 在 register 时固化资格）。
                self.eligible.remove(interaction);
            }
        }
        self.activate_head(pending, now)
    }

    /// 一个交互离开了队列（回答、取消、清空）。队首换了时给下一个够格的问题起表。
    pub fn on_resolved(&mut self, pending: &mut [Value], interaction: &str, now: u64) -> bool {
        self.eligible.remove(interaction);
        self.in_flight.remove(interaction);
        self.activate_head(pending, now)
    }

    /// 待答交互被整体清掉（历史改写）。
    pub fn clear(&mut self) {
        self.eligible.clear();
        self.in_flight.clear();
    }

    /// 队首如果是够格的 AskUserQuestion 且还没有计时，就进入 `hiddenGrace`。
    pub(super) fn activate_head(&mut self, pending: &mut [Value], now: u64) -> bool {
        let Some(head) = pending.iter().position(queued) else {
            return false;
        };
        let entry = &mut pending[head];
        let Some(id) = entry["interactionId"].as_str().map(str::to_owned) else {
            return false;
        };
        if !is_question_entry(entry) || !self.eligible.contains(&id) {
            return false;
        }
        // `snoozed` 与已经起了表的都保持原样（Node 的 `activateHead` 同一判据）。
        if entry
            .get("autoResolution")
            .is_some_and(|state| !state.is_null())
        {
            return false;
        }
        entry["autoResolution"] = json!({
            "state": "hiddenGrace",
            "startedAt": now,
            "visibleAt": now.saturating_add(self.hidden_grace_ms),
            "deadlineAt": now.saturating_add(self.auto_resolution_ms),
        });
        true
    }

    /// 现在到点的转换与到期应答（按队列顺序）。
    pub fn due(&self, pending: &[Value], now: u64) -> Vec<Step> {
        let mut steps = Vec::new();
        for entry in pending {
            let Some(id) = entry["interactionId"].as_str() else {
                continue;
            };
            let Some(state) = entry.get("autoResolution") else {
                continue;
            };
            let deadline = state["deadlineAt"].as_u64().unwrap_or(u64::MAX);
            if now >= deadline {
                if !self.in_flight.contains(id) {
                    steps.push(Step::Resolve(id.to_owned()));
                }
                continue;
            }
            if state["state"].as_str() == Some("hiddenGrace")
                && now >= state["visibleAt"].as_u64().unwrap_or(u64::MAX)
            {
                steps.push(Step::Visible(id.to_owned()));
            }
        }
        steps
    }

    /// `hiddenGrace` → `visibleCountdown`。状态没变时返回 false。
    pub fn mark_visible(&mut self, pending: &mut [Value], interaction: &str) -> bool {
        let Some(state) = state_of(pending, interaction) else {
            return false;
        };
        if state.get("state").and_then(Value::as_str) != Some("hiddenGrace") {
            return false;
        }
        // 只改阶段，绝对时间不动（Node 的 visibleTimer 同一写法）。
        state.insert("state".into(), json!("visibleCountdown"));
        true
    }

    /// 记住“已经发过自动应答”，等 `InteractionResolved` 收口。
    pub fn mark_in_flight(&mut self, interaction: &str) {
        self.in_flight.insert(interaction.to_owned());
    }

    /// 自动应答被内核拒绝（交互已经不在）：撤掉计时与资格，别每秒重发。
    /// 返回是否真的改了状态。
    pub fn abandon(&mut self, pending: &mut [Value], interaction: &str) -> bool {
        self.eligible.remove(interaction);
        self.in_flight.remove(interaction);
        let Some(entry) = pending
            .iter_mut()
            .find(|entry| entry["interactionId"].as_str() == Some(interaction))
        else {
            return false;
        };
        entry.as_object_mut().is_some_and(|entry| {
            entry
                .remove("autoResolution")
                .is_some_and(|state| !state.is_null())
        })
    }

    /// 用户第一次操作：倒计时永久换成 `snoozed`。不是活动倒计时时返回 false。
    pub fn snooze(&mut self, pending: &mut [Value], interaction: &str, now: u64) -> bool {
        let Some(state) = state_of(pending, interaction) else {
            return false;
        };
        if state.get("state").and_then(Value::as_str) == Some("snoozed") {
            return false;
        }
        let started_at = state
            .get("startedAt")
            .and_then(Value::as_u64)
            .unwrap_or(now);
        state.clear();
        state.insert("state".into(), json!("snoozed"));
        state.insert("startedAt".into(), json!(started_at));
        state.insert("snoozedAt".into(), json!(now));
        true
    }

    /// 关掉偏好：把仍在计时的 AskUserQuestion 全部换成 `snoozed`，返回换掉的条数。
    ///
    /// 打开偏好只让**之后**登记的问题计时（Node `setAskUserQuestionAutoResolutionEnabled`）。
    pub fn set_enabled(&mut self, pending: &mut [Value], enabled: bool, now: u64) -> usize {
        self.enabled = enabled;
        if enabled {
            return 0;
        }
        let mut snoozed = 0;
        for entry in pending.iter_mut() {
            if !is_question_entry(entry) {
                continue;
            }
            let Some(id) = entry["interactionId"].as_str().map(str::to_owned) else {
                continue;
            };
            self.eligible.remove(&id);
            let Some(state) = entry.get("autoResolution") else {
                continue;
            };
            if state["state"].as_str() == Some("snoozed") {
                continue;
            }
            let started_at = state["startedAt"].as_u64().unwrap_or(now);
            entry["autoResolution"] = json!({
                "state": "snoozed",
                "startedAt": started_at,
                "snoozedAt": now,
            });
            snoozed += 1;
        }
        snoozed
    }

    /// 下一次需要醒来处理的时刻（可见转换或到期）。在途的到期不算。
    pub fn next_at(&self, pending: &[Value]) -> Option<u64> {
        let mut next: Option<u64> = None;
        for entry in pending {
            let Some(id) = entry["interactionId"].as_str() else {
                continue;
            };
            if self.in_flight.contains(id) {
                continue;
            }
            let Some(state) = entry.get("autoResolution") else {
                continue;
            };
            let candidate = match state["state"].as_str() {
                Some("hiddenGrace") => {
                    let visible = state["visibleAt"].as_u64().unwrap_or(u64::MAX);
                    let deadline = state["deadlineAt"].as_u64().unwrap_or(u64::MAX);
                    Some(visible.min(deadline))
                }
                Some("visibleCountdown") => Some(state["deadlineAt"].as_u64().unwrap_or(u64::MAX)),
                _ => None,
            };
            if let Some(candidate) = candidate {
                next = Some(next.map_or(candidate, |next| next.min(candidate)));
            }
        }
        next
    }
}

/// 队列成员：权限、提问与计划审批（工作区钩子评审不进队列）。
fn queued(entry: &Value) -> bool {
    matches!(
        entry["payload"]["kind"].as_str(),
        Some("permission" | "userInput")
    )
}

fn is_question_entry(entry: &Value) -> bool {
    entry["payload"]["kind"] == "userInput"
        && entry["payload"]["toolName"] == crate::projection::state::ASK_USER_QUESTION_TOOL
}

fn is_question(pending: &[Value], interaction: &str) -> bool {
    pending
        .iter()
        .find(|entry| entry["interactionId"].as_str() == Some(interaction))
        .is_some_and(is_question_entry)
}

fn state_of<'a>(pending: &'a mut [Value], interaction: &str) -> Option<&'a mut Map<String, Value>> {
    pending
        .iter_mut()
        .find(|entry| entry["interactionId"].as_str() == Some(interaction))
        .and_then(|entry| entry.get_mut("autoResolution"))
        .and_then(Value::as_object_mut)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question(id: &str) -> Value {
        json!({
            "interactionId": id,
            "kind": "userInput",
            "anchorRowId": 1,
            "createdAt": 1_000,
            "payload": {
                "kind": "userInput",
                "toolName": "AskUserQuestion",
                "toolCallId": "tool-1",
                "questions": [],
            },
        })
    }

    fn permission(id: &str) -> Value {
        json!({
            "interactionId": id,
            "kind": "permission",
            "anchorRowId": 2,
            "createdAt": 1_000,
            "payload": {"kind": "permission", "toolName": "Bash"},
        })
    }

    #[test]
    fn only_the_head_question_counts_down() {
        let mut registry = AutoResolution::new(true).with_timing(60, 300);
        let mut pending = vec![question("q1"), question("q2")];

        assert!(registry.on_asked(&mut pending, "q1", 1_000));
        assert!(!registry.on_asked(&mut pending, "q2", 1_000));
        assert_eq!(pending[0]["autoResolution"]["state"], "hiddenGrace");
        assert!(pending[1].get("autoResolution").is_none());

        pending.remove(0);
        assert!(registry.on_resolved(&mut pending, "q1", 1_010));
        assert_eq!(pending[0]["autoResolution"]["state"], "hiddenGrace");
        assert_eq!(pending[0]["autoResolution"]["startedAt"], 1_010);
    }

    #[test]
    fn a_permission_at_the_head_blocks_the_question() {
        let mut registry = AutoResolution::new(true).with_timing(60, 300);
        let mut pending = vec![permission("p1"), question("q1")];

        assert!(!registry.on_asked(&mut pending, "q1", 1_000));
        assert!(pending[1].get("autoResolution").is_none());
        pending.remove(0);
        assert!(registry.on_resolved(&mut pending, "p1", 1_500));
        assert_eq!(pending[0]["autoResolution"]["state"], "hiddenGrace");
    }

    #[test]
    fn visible_then_resolve_uses_absolute_times() {
        let mut registry = AutoResolution::new(true).with_timing(60, 300);
        let mut pending = vec![question("q1")];
        registry.on_asked(&mut pending, "q1", 1_000);

        assert!(registry.due(&pending, 1_059).is_empty());
        assert_eq!(
            registry.due(&pending, 1_060),
            vec![Step::Visible("q1".to_owned())]
        );
        assert!(registry.mark_visible(&mut pending, "q1"));
        assert_eq!(pending[0]["autoResolution"]["state"], "visibleCountdown");
        assert_eq!(pending[0]["autoResolution"]["visibleAt"], 1_060);

        assert!(registry.due(&pending, 1_299).is_empty());
        assert_eq!(
            registry.due(&pending, 1_300),
            vec![Step::Resolve("q1".to_owned())]
        );
        registry.mark_in_flight("q1");
        assert!(registry.due(&pending, 1_400).is_empty());
        assert!(registry.next_at(&pending).is_none());
    }

    #[test]
    fn a_jump_past_the_deadline_resolves_without_the_visible_step() {
        let mut registry = AutoResolution::new(true).with_timing(60, 300);
        let mut pending = vec![question("q1")];
        registry.on_asked(&mut pending, "q1", 1_000);
        assert_eq!(
            registry.due(&pending, 9_999),
            vec![Step::Resolve("q1".to_owned())]
        );
    }

    #[test]
    fn snooze_is_permanent_and_idempotent() {
        let mut registry = AutoResolution::new(true).with_timing(60, 300);
        let mut pending = vec![question("q1")];
        registry.on_asked(&mut pending, "q1", 1_000);

        assert!(registry.snooze(&mut pending, "q1", 1_030));
        assert!(!registry.snooze(&mut pending, "q1", 1_040));
        assert_eq!(pending[0]["autoResolution"]["state"], "snoozed");
        assert_eq!(pending[0]["autoResolution"]["startedAt"], 1_000);
        assert_eq!(pending[0]["autoResolution"]["snoozedAt"], 1_030);
        assert!(registry.due(&pending, 9_999).is_empty());
        assert!(registry.next_at(&pending).is_none());
    }

    #[test]
    fn snooze_ignores_other_interactions_and_snoozed_entries() {
        let mut registry = AutoResolution::new(true).with_timing(60, 300);
        let mut pending = vec![permission("p1")];
        assert!(!registry.snooze(&mut pending, "p1", 1_030));
        assert!(pending[0].get("autoResolution").is_none());
    }

    #[test]
    fn disabling_snoozes_active_countdowns_and_never_retroactively_starts() {
        let mut registry = AutoResolution::new(true).with_timing(60, 300);
        let mut pending = vec![question("q1"), question("q2")];
        registry.on_asked(&mut pending, "q1", 1_000);
        registry.on_asked(&mut pending, "q2", 1_000);

        assert_eq!(registry.set_enabled(&mut pending, false, 1_100), 1);
        assert_eq!(pending[0]["autoResolution"]["state"], "snoozed");
        assert!(pending[1].get("autoResolution").is_none());

        // 重新打开：老问题不追溯（队首 q1 仍占着队列），只有之后登记的问题计时。
        assert_eq!(registry.set_enabled(&mut pending, true, 1_200), 0);
        pending.remove(0);
        assert!(!registry.on_resolved(&mut pending, "q1", 1_200));
        assert!(pending[0].get("autoResolution").is_none());
        // 队首的 q2 是关闭期间问的，永远不计时；它走了以后新问题才起表。
        pending.remove(0);
        assert!(!registry.on_resolved(&mut pending, "q2", 1_250));
        pending.push(question("q3"));
        assert!(registry.on_asked(&mut pending, "q3", 1_300));
        assert_eq!(pending[0]["autoResolution"]["startedAt"], 1_300);
    }

    #[test]
    fn a_question_asked_while_disabled_never_times() {
        let mut registry = AutoResolution::new(false).with_timing(60, 300);
        let mut pending = vec![question("q1")];
        assert!(!registry.on_asked(&mut pending, "q1", 1_000));
        assert!(pending[0].get("autoResolution").is_none());

        registry.set_enabled(&mut pending, true, 1_100);
        assert!(!registry.on_resolved(&mut pending, "p9", 1_200));
        assert!(pending[0].get("autoResolution").is_none());
    }

    #[test]
    fn a_cold_open_question_starts_the_clock_from_the_open() {
        let mut registry = AutoResolution::new(true).with_timing(60, 300);
        let mut pending = vec![question("q1")];
        assert!(registry.seed(&mut pending, 5_000));
        assert_eq!(pending[0]["autoResolution"]["startedAt"], 5_000);

        let mut disabled = AutoResolution::new(false).with_timing(60, 300);
        let mut pending = vec![question("q1")];
        assert!(!disabled.seed(&mut pending, 5_000));
        assert!(pending[0].get("autoResolution").is_none());
    }

    #[test]
    fn abandon_removes_the_countdown_without_touching_the_interaction() {
        let mut registry = AutoResolution::new(true).with_timing(60, 300);
        let mut pending = vec![question("q1")];
        registry.on_asked(&mut pending, "q1", 1_000);
        registry.mark_in_flight("q1");

        assert!(registry.abandon(&mut pending, "q1"));
        assert!(pending[0].get("autoResolution").is_none());
        assert!(!registry.abandon(&mut pending, "q1"));
        assert!(registry.next_at(&pending).is_none());
    }
}
