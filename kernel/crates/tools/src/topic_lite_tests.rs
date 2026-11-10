//! lite 抽取的材料、切块与选块（Node `buildTranscriptChunks` / `selectChunks` / `truncateForLite`）。

use nibi_kernel_api::ids::SessionId;

use super::*;

fn snippet(index: usize, role: &'static str, body: &str) -> Snippet {
    Snippet {
        index,
        id: format!("msg_{index}"),
        role,
        body: body.to_owned(),
        score: 1.0,
    }
}

fn target<'a>(session: &'a SessionId) -> Target<'a> {
    Target {
        title: "Config work",
        directory: Some("D:/work"),
        session,
        strategy: "relevant",
        query: "config",
        output_char_budget: 24_000,
    }
}

#[test]
fn the_material_is_a_cleaned_transcript_with_a_header() {
    let session = SessionId::new("sess_1");
    let text = material(&target(&session), &[snippet(0, "user", "hello")]);
    assert!(text.starts_with("# Cleaned transcript\n"));
    assert!(text.contains("Session: Config work (sess_1)"));
    assert!(text.contains("Directory: D:/work"));
    assert!(text.contains("Strategy: relevant"));
    assert!(text.contains("Query: config"));
    // 消息头与 Node 同形：`[序号] 角色 id`。
    assert!(text.contains("[1] user msg_0\nhello"));
}

#[test]
fn chunks_split_at_twenty_eight_thousand_characters() {
    let long = "x".repeat(20_000);
    let snippets = vec![
        snippet(0, "user", &long),
        snippet(1, "assistant", &long),
        snippet(2, "user", &long),
    ];
    let chunks = chunks(&snippets);
    assert_eq!(chunks.len(), 3, "each pair exceeds the 28k limit");
    assert_eq!((chunks[0].start, chunks[0].end, chunks[0].count), (0, 0, 1));
}

#[test]
fn handoff_takes_the_last_five_chunks_and_relevant_keeps_the_last_one() {
    let long = "x".repeat(28_000);
    let snippets: Vec<Snippet> = (0..12)
        .map(|index| {
            let mut snippet = snippet(index, "user", &format!("{long}{index}"));
            // 前四块分数最高、最后一块最低：relevant 取前四块后还要补最后一块（Node 的 Map 去重）。
            snippet.score = if index < 4 { 100.0 } else { 1.0 };
            snippet
        })
        .collect();
    let all = chunks(&snippets);
    assert!(all.len() > MAX_LITE_CHUNKS);
    let last = all.len() - 1;

    let selected = select_chunks(chunks(&snippets), "handoff");
    assert_eq!(selected.len(), MAX_LITE_CHUNKS);
    assert_eq!(selected[0].index, last + 1 - MAX_LITE_CHUNKS);

    let selected = select_chunks(chunks(&snippets), "relevant");
    assert_eq!(selected.len(), MAX_LITE_CHUNKS);
    assert_eq!(
        selected.last().map(|chunk| chunk.index),
        Some(last),
        "the tail chunk is always kept"
    );
}

#[test]
fn the_input_is_truncated_past_eighty_thousand_characters() {
    let text = "y".repeat(MAX_LITE_INPUT_CHARS + 100);
    let truncated = truncate_for_lite(&text);
    assert_eq!(
        truncated.chars().count(),
        MAX_LITE_INPUT_CHARS - 18 + "\n...[truncated]".chars().count()
    );
    assert!(truncated.ends_with("\n...[truncated]"));
}
