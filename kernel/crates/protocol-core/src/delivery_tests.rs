use super::*;

fn open() -> HashSet<String> {
    HashSet::new()
}

#[test]
fn started_subscribers_get_only_what_came_after_their_first_frame() {
    let mut log = TopicLog::<&str>::new("e1");
    assert_eq!(log.record(vec!["a"]), 1);
    log.subscribe("s1", "c1");
    // 首帧之前没有增量。
    log.record(vec!["b"]);
    assert!(log.flush(&open()).is_empty());
    assert_eq!(log.start("s1"), Some(2));
    log.record(vec!["c", "d"]);
    log.record(Vec::new());
    log.subscribe("s2", "c2");
    log.record(vec!["e"]);
    assert_eq!(log.start("s2"), Some(4));
    log.record(vec!["f"]);
    assert_eq!(
        log.flush(&open()),
        vec![
            Batch {
                subscription: "s1".to_owned(),
                from: 2,
                to: 5,
                deltas: vec!["c", "d", "e", "f"],
            },
            Batch {
                subscription: "s2".to_owned(),
                from: 4,
                to: 5,
                deltas: vec!["f"],
            },
        ]
    );
    assert!(log.flush(&open()).is_empty());
    assert_eq!(log.epoch(), "e1");
}

#[test]
fn the_same_connection_replaces_its_subscription() {
    let mut log = TopicLog::<u8>::new("e");
    assert_eq!(log.subscribe("s1", "c1"), None);
    assert_eq!(log.subscribe("s2", "c1"), Some("s1".to_owned()));
    assert!(!log.has_subscription("s1"));
    assert_eq!(log.start("s1"), None);
    log.subscribe("s3", "c2");
    assert_eq!(log.drop_connection("c1"), vec!["s2".to_owned()]);
    assert!(log.unsubscribe("s3"));
    assert!(log.subscribers().is_empty());
}

#[test]
fn a_restarted_subscription_waits_for_a_new_first_frame() {
    let mut log = TopicLog::<u8>::new("e");
    log.subscribe("s1", "c1");
    log.start("s1");
    log.record(vec![1]);
    assert!(log.restart("s1"));
    log.record(vec![2]);
    assert!(log.flush(&open()).is_empty());
    assert_eq!(log.start("s1"), Some(2));
    assert!(!log.restart("gone"));
}

#[test]
fn a_subscription_resumes_from_a_base_inside_the_retention_window() {
    let mut log = TopicLog::<&str>::new("e1");
    log.record(vec!["a"]);
    log.record(vec!["b"]);
    log.record(vec!["c"]);
    log.subscribe("s1", "c1");
    // 同代、窗内（含 0 与当前序号）：续传，位置回到 base。
    assert_eq!(log.resume("s1", "e1", 0), Some(3));
    assert_eq!(log.deltas_after(0), vec!["a", "b", "c"]);
    assert_eq!(log.resume("s1", "e1", 2), Some(3));
    assert_eq!(log.deltas_after(2), vec!["c"]);
    // base == 当前序号：不需要增量。
    assert_eq!(log.resume("s1", "e1", 3), Some(3));
    assert!(log.deltas_after(3).is_empty());
    // 代际不符或越过当前序号：不能续传。
    assert_eq!(log.resume("s1", "other", 2), None);
    assert_eq!(log.resume("s1", "e1", 4), None);
    // 订阅不在同样不行。
    assert_eq!(log.resume("gone", "e1", 2), None);
}

#[test]
fn evicted_entries_advance_the_floor_and_block_resume() {
    let mut log = TopicLog::<&str>::with_retention("e1", 2);
    log.record(vec!["a"]); // 1
    log.record(vec!["b"]); // 2
    assert_eq!(log.floor(), 0);
    log.record(vec!["c"]); // 3 → 淘汰 1
    assert_eq!(log.floor(), 1);
    assert_eq!(log.deltas_after(1), vec!["b", "c"]);
    log.subscribe("s1", "c1");
    // base == floor 仍可无损续传（floor 那一组已经给了客户端）。
    assert_eq!(log.resume("s1", "e1", 1), Some(3));
    // 早于 floor：无法补齐，只能快照。
    assert_eq!(log.resume("s1", "e1", 0), None);
}

#[test]
fn a_subscriber_that_fell_behind_the_window_gets_an_empty_batch() {
    let mut log = TopicLog::<&str>::with_retention("e1", 2);
    log.subscribe("s1", "c1");
    log.start("s1"); // acked = 0
    log.record(vec!["a"]); // 1
    log.record(vec!["b"]); // 2
    log.record(vec!["c"]); // 3 → floor = 1
    log.record(vec!["d"]); // 4 → floor = 2（acked = 0 已落到窗外）
    let batches = log.flush(&open());
    assert_eq!(batches.len(), 1);
    assert_eq!((batches[0].from, batches[0].to), (0, 4));
    // 增量补不齐：调用方据此改发快照。
    assert!(batches[0].deltas.is_empty());
}

#[test]
fn a_paused_connection_keeps_its_position_and_gets_everything_later() {
    let mut log = TopicLog::<&str>::new("e1");
    log.subscribe("s1", "c1");
    log.start("s1");
    log.record(vec!["a"]);
    let paused: HashSet<String> = ["c1".to_owned()].into();
    assert!(log.flush(&paused).is_empty());
    log.record(vec!["b"]);
    // 恢复（drained）：暂停期间的全部增量一次补齐。
    assert_eq!(
        log.flush(&open()),
        vec![Batch {
            subscription: "s1".to_owned(),
            from: 0,
            to: 2,
            deltas: vec!["a", "b"],
        }]
    );
}
