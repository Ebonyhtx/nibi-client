//! 会话的附加工作目录（NIBI `createSession.additionalDirectories`）。
//!
//! 与进程级的 `--add-dir`（[`crate::env::EnvFacts::additional_directories`]）不同：这批目录属于
//! **一个会话**，由 Host 在建会话时给出（用户在工作区之外添加的目录）。消费点是两处，都按会话取：
//! - 判决链：工作区之外的这些目录按"在工作区内"处理（不逐次询问）；
//! - 提示词的环境段：列出额外工作目录，模型知道可以读它们。
//!
//! 句柄本身只存表；`runtime` 在 createSession 时写入、会话关闭时释放，子代理继承父会话的条目。

use std::collections::BTreeMap;
use std::sync::{Mutex, MutexGuard, PoisonError};

use crate::env::EnvPath;
use crate::ids::SessionId;

/// 会话 → 附加工作目录。
#[derive(Debug, Default)]
pub struct SessionDirectories {
    entries: Mutex<BTreeMap<SessionId, Vec<EnvPath>>>,
}

impl SessionDirectories {
    pub fn new() -> Self {
        Self::default()
    }

    fn entries(&self) -> MutexGuard<'_, BTreeMap<SessionId, Vec<EnvPath>>> {
        self.entries
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// 给会话设置这批目录（再次设置时整体替换）。
    pub fn set(&self, session: &SessionId, directories: Vec<EnvPath>) {
        if directories.is_empty() {
            self.release(session);
            return;
        }
        self.entries().insert(session.clone(), directories);
    }

    /// 会话现在的附加目录（按给定顺序，可能有重复）。
    pub fn get(&self, session: &SessionId) -> Vec<EnvPath> {
        self.entries().get(session).cloned().unwrap_or_default()
    }

    /// 子代理会话继承父会话的附加目录（与 MCP 继承同一套；子代理能读父会话能读的目录）。
    pub fn inherit(&self, parent: &SessionId, child: &SessionId) {
        let directories = self.get(parent);
        if !directories.is_empty() {
            self.entries().insert(child.clone(), directories);
        }
    }

    /// 会话关闭：释放它的表。
    pub fn release(&self, session: &SessionId) {
        self.entries().remove(session);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(path: &str) -> EnvPath {
        EnvPath::new(path)
    }

    #[test]
    fn setting_getting_inheriting_and_releasing() {
        let directories = SessionDirectories::new();
        let parent = SessionId::new("sess_parent");
        let child = SessionId::new("sess_child");
        assert!(directories.get(&parent).is_empty());
        directories.set(&parent, vec![dir("/a"), dir("/b")]);
        assert_eq!(directories.get(&parent), vec![dir("/a"), dir("/b")]);
        directories.inherit(&parent, &child);
        assert_eq!(directories.get(&child), vec![dir("/a"), dir("/b")]);
        // 再设置一次是整体替换；空列表等于释放。
        directories.set(&parent, vec![dir("/c")]);
        assert_eq!(directories.get(&parent), vec![dir("/c")]);
        // 子会话关闭只释放自己的条目。
        directories.release(&child);
        assert!(directories.get(&child).is_empty());
        assert_eq!(directories.get(&parent), vec![dir("/c")]);
        directories.set(&parent, Vec::new());
        assert!(directories.get(&parent).is_empty());
        // 父会话没有目录时继承是空操作。
        directories.inherit(&parent, &child);
        assert!(directories.get(&child).is_empty());
    }
}
