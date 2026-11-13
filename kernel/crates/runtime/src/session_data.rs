//! `v4/storage/sessionData/measure|purge` 的内核执行面（上游 `apps/nibi-cli/packages/bootstrap/src/
//! zcode-protocol/session-data/index.ts`）。
//!
//! 语义与上游逐条对齐：
//! - 以会话根为单位展开附属后代（subagent / workflow / selection side chat；fork 不展开）；
//! - 树中任一会话在本进程忙（在途回合、排队输入、待回答交互、后台工作）时整棵保留 `running`；
//! - 树中任一会话仍被本次不删除的未删除会话引用（产物 URI、父链、工作流链接、分享）时整棵保留
//!   `referenced`，保留一棵会让引用它的树也变成「本次不删除」，迭代到不动点；
//! - 先删文件再删行：文件失败时行还在，重试仍能找到；空闲已加载的会话先走现有关闭路径释放运行态；
//! - 幂等：已不存在的会话按 0 字节删除成功。
//!
//! 这里只做编排；会话树的 SQL、引用扫描与行删除在 `nibi-kernel-node-store`，运行态在本进程的会话表。

use std::collections::HashSet;

use crate::LocalKernel;
use nibi_kernel_api::ids::SessionId;
use nibi_kernel_api::session_api::{KernelError, SessionHandle};
use nibi_kernel_api::session_data::{
    SessionDataBytes, SessionDataFailure, SessionDataKept, SessionDataKeptReason,
    SessionDataMeasure, SessionDataMemoryBytes, SessionDataParams, SessionDataPurge,
};

fn failed(error: impl std::fmt::Display) -> KernelError {
    KernelError::Failed {
        message: error.to_string(),
    }
}

fn file_failed(
    session: &SessionId,
    error: nibi_kernel_api::session_data::SessionDataError,
) -> KernelError {
    KernelError::Failed {
        message: format!("{session}: {}", error.code),
    }
}

/// 树或根自身：库里没有这个根时按根自身处理（清理可能残留的会话文件，结果按 0 行删除成功）。
fn roots_of(
    trees: &std::collections::HashMap<SessionId, Vec<SessionId>>,
    root: &SessionId,
) -> Vec<SessionId> {
    trees
        .get(root)
        .filter(|ids| !ids.is_empty())
        .cloned()
        .unwrap_or_else(|| vec![root.clone()])
}

impl LocalKernel {
    pub(crate) async fn session_data_measure(
        &self,
        params: SessionDataParams,
    ) -> Result<SessionDataMeasure, KernelError> {
        let trees = self
            .ports
            .store
            .owned_session_trees(&params.session_ids)
            .await
            .map_err(failed)?;
        let mut sessions = Vec::with_capacity(params.session_ids.len());
        for root in &params.session_ids {
            let mut bytes = 0;
            for id in roots_of(&trees, root) {
                bytes += self
                    .ports
                    .store
                    .measure_session_files(&id)
                    .await
                    .map_err(|error| file_failed(&id, error))?;
            }
            sessions.push(SessionDataBytes {
                session_id: root.clone(),
                bytes,
            });
        }
        let mut memory = Vec::with_capacity(params.directories.len());
        for directory in &params.directories {
            let bytes = self
                .ports
                .store
                .measure_project_memory(directory)
                .await
                .map_err(|error| failed(format!("{}: {}", directory.workspace_path, error.code)))?;
            memory.push(SessionDataMemoryBytes {
                workspace_path: directory.workspace_path.clone(),
                bytes,
            });
        }
        Ok(SessionDataMeasure { sessions, memory })
    }

    pub(crate) async fn session_data_purge(
        &self,
        params: SessionDataParams,
    ) -> Result<SessionDataPurge, KernelError> {
        let trees = self
            .ports
            .store
            .owned_session_trees(&params.session_ids)
            .await
            .map_err(failed)?;
        let all: Vec<(SessionId, Vec<SessionId>)> = params
            .session_ids
            .iter()
            .map(|root| (root.clone(), roots_of(&trees, root)))
            .collect();

        // 运行中的树整棵保留：删掉正在写入的会话会让 turn 写库失败。
        let mut running: HashSet<SessionId> = HashSet::new();
        for (root, ids) in &all {
            for id in ids {
                if self.session_data_busy(id).await {
                    running.insert(root.clone());
                    break;
                }
            }
        }
        let candidates: Vec<(SessionId, Vec<SessionId>)> = all
            .iter()
            .filter(|(root, _)| !running.contains(root))
            .cloned()
            .collect();
        let candidate_ids: Vec<SessionId> = candidates
            .iter()
            .flat_map(|(_, ids)| ids.iter().cloned())
            .collect();
        let mut removable: HashSet<SessionId> = candidate_ids.iter().cloned().collect();

        // 分享中的会话被外部事实钉住；不参与删除，并让引用它的树也保留。
        let pinned: HashSet<SessionId> = self
            .ports
            .store
            .session_data_pinned(&candidate_ids)
            .await
            .map_err(failed)?
            .into_iter()
            .filter(|root| !running.contains(root))
            .collect();
        // workflow_activity 等活动记录不是会话，但同样引用着子会话：活动行不随会话删除
        // （`on delete set null`），删掉会话会让待继续/可重放的工作流失去目标。与分享同一
        // 口径整棵保留；被引用的可能是根也可能是附属后代，所以按树内任一会话命中判断。
        let activity_referenced: HashSet<SessionId> = self
            .ports
            .store
            .session_data_external_references(&candidate_ids)
            .await
            .map_err(failed)?
            .into_iter()
            .collect();
        let mut referenced: HashSet<SessionId> = HashSet::new();
        for (root, ids) in &candidates {
            if ids
                .iter()
                .any(|id| pinned.contains(id) || activity_referenced.contains(id))
            {
                referenced.insert(root.clone());
                for id in ids {
                    removable.remove(id);
                }
            }
        }

        // 附件仍被本次不删除的会话引用的树整棵保留：fork、回退与工作流转录按值复制 part，
        // `*-artifact://<源会话>/…` 仍指向源会话的附件目录。保留一棵会让引用它的树也变成
        // 「本次不删除」，迭代到不动点。
        let referrers = self
            .ports
            .store
            .session_data_referrers(&candidate_ids)
            .await
            .map_err(failed)?;
        loop {
            let mut changed = false;
            for (root, ids) in &candidates {
                if referenced.contains(root) {
                    continue;
                }
                let outside = ids.iter().any(|id| {
                    referrers.get(id).is_some_and(|refs| {
                        refs.iter().any(|referrer| !removable.contains(referrer))
                    })
                });
                if !outside {
                    continue;
                }
                referenced.insert(root.clone());
                for id in ids {
                    removable.remove(id);
                }
                changed = true;
            }
            if !changed {
                break;
            }
        }

        let mut result = SessionDataPurge {
            deleted: Vec::new(),
            kept: Vec::new(),
            failed: Vec::new(),
            memory: Vec::new(),
        };
        for (root, ids) in &all {
            if running.contains(root) {
                result.kept.push(SessionDataKept {
                    session_id: root.clone(),
                    reason: SessionDataKeptReason::Running,
                });
                continue;
            }
            if referenced.contains(root) {
                result.kept.push(SessionDataKept {
                    session_id: root.clone(),
                    reason: SessionDataKeptReason::Referenced,
                });
                continue;
            }
            let mut bytes = 0;
            let mut failure = None;
            for id in ids {
                // 空闲已加载的会话先释放运行态；关闭失败按本次删除失败处理，行与文件都还在。
                if let Err(error) = self.close_open(id).await {
                    tracing::warn!(session = %id, %error, "could not release an idle session before purging it");
                    failure = Some("unknown".to_owned());
                    break;
                }
                match self.ports.store.remove_session_files(id).await {
                    Ok(size) => bytes += size,
                    Err(error) => {
                        failure = Some(error.code);
                        break;
                    }
                }
            }
            if failure.is_none()
                && let Err(error) = self
                    .ports
                    .store
                    .purge_session_rows(std::slice::from_ref(root))
                    .await
            {
                tracing::warn!(session = %root, %error, "could not purge the session rows");
                failure = Some("unknown".to_owned());
            }
            match failure {
                Some(code) => result.failed.push(SessionDataFailure {
                    session_id: Some(root.clone()),
                    workspace_path: None,
                    code,
                }),
                None => result.deleted.push(SessionDataBytes {
                    session_id: root.clone(),
                    bytes,
                }),
            }
        }

        for directory in &params.directories {
            match self.ports.store.remove_project_memory(directory).await {
                Ok(bytes) => result.memory.push(SessionDataMemoryBytes {
                    workspace_path: directory.workspace_path.clone(),
                    bytes,
                }),
                Err(error) => result.failed.push(SessionDataFailure {
                    session_id: None,
                    workspace_path: Some(directory.workspace_path.clone()),
                    code: error.code,
                }),
            }
        }
        Ok(result)
    }

    /// 本进程已加载的会话是否在忙：在途回合、排队输入、待回答交互或后台工作（含后台子代理）。
    /// 未加载返回 false；正在加载/关闭的会话按忙处理（不在这里等它的冷加载）。读不出视图时也按忙
    /// 处理（宁可少删）。
    async fn session_data_busy(&self, session: &SessionId) -> bool {
        let open = {
            let sessions = self.sessions();
            match sessions.get(session) {
                None => None,
                Some(slot) => match slot.open() {
                    Some(open) => Some(open.clone()),
                    // Loading / Closing：状态还没稳定，整棵保留。
                    None => return true,
                },
            }
        };
        let Some(open) = open else {
            return false;
        };
        match open.view().await {
            Ok(view) => {
                view.running
                    || !view.queue.is_empty()
                    || !view.pending.is_empty()
                    || !view.background.is_empty()
            }
            Err(error) => {
                tracing::warn!(session = %session, %error, "could not read a session view while measuring running state");
                true
            }
        }
    }
}

#[cfg(test)]
#[path = "session_data_tests.rs"]
mod tests;
