//! canonical → OpenAI 公共降级（model.md §10）。

use nibi_kernel_api::ids::ToolUseId;
use nibi_kernel_api::model::{ApiContent, CacheControl};
use serde_json::json;

use super::*;

pub(crate) fn content(block: ContentBlock) -> ApiContent {
    ApiContent {
        block,
        cache_control: Some(CacheControl {
            kind: "ephemeral".to_owned(),
            ttl: None,
            scope: None,
        }),
    }
}

pub(crate) fn text(body: &str) -> ContentBlock {
    ContentBlock::Text {
        text: body.to_owned(),
    }
}

pub(crate) fn message(role: ApiRole, blocks: Vec<ContentBlock>) -> ApiMessage {
    ApiMessage {
        role,
        content: blocks.into_iter().map(content).collect(),
        output_config: None,
    }
}

pub(crate) fn image() -> ImageSource {
    ImageSource::Base64 {
        media_type: "image/png".to_owned(),
        data: "AAAA".to_owned(),
    }
}

/// 一段带工具调用、工具结果（含图片）、中途 system 消息与 thinking 的对话。
pub(crate) fn conversation() -> Vec<ApiMessage> {
    vec![
        message(
            ApiRole::User,
            vec![
                text("<system-reminder>ctx</system-reminder>"),
                text("read a.png"),
            ],
        ),
        message(ApiRole::System, vec![text("# Environment")]),
        message(
            ApiRole::Assistant,
            vec![
                ContentBlock::Thinking {
                    thinking: "need the file".to_owned(),
                    signature: Some("sig".to_owned()),
                },
                ContentBlock::RedactedThinking {
                    data: "opaque".to_owned(),
                },
                ContentBlock::ToolUse {
                    id: ToolUseId::new("toolu_1"),
                    name: "Read".to_owned(),
                    input: json!({"file_path": "a.png"}),
                },
            ],
        ),
        message(ApiRole::System, vec![text("late note")]),
        message(
            ApiRole::User,
            vec![
                ContentBlock::ToolResult {
                    tool_use_id: ToolUseId::new("toolu_1"),
                    content: vec![
                        ToolResultContent::Text {
                            text: "line 1".to_owned(),
                        },
                        ToolResultContent::Text {
                            text: "line 2".to_owned(),
                        },
                        ToolResultContent::Image { source: image() },
                    ],
                    is_error: false,
                },
                text("thanks"),
            ],
        ),
        message(ApiRole::Assistant, vec![text("It is a cat.")]),
    ]
}

#[test]
fn messages_lower_to_protocol_neutral_items() {
    let system = vec![
        SystemBlock {
            text: "You are NIBI.".to_owned(),
            cache_control: None,
        },
        SystemBlock {
            text: "Be brief.".to_owned(),
            cache_control: None,
        },
    ];
    let lowered = items(system, conversation()).unwrap();
    let reminder =
        |body: &str| Part::Text(format!("<system-reminder>\n{body}\n</system-reminder>"));
    assert_eq!(
        lowered,
        vec![
            Item::System("You are NIBI.\n\nBe brief.".to_owned()),
            Item::User(vec![
                Part::Text("<system-reminder>ctx</system-reminder>".to_owned()),
                Part::Text("read a.png".to_owned()),
                // 中途的 system 消息并进它之前的 user 回合（在 assistant 之前写出）。
                reminder("# Environment"),
            ]),
            Item::Assistant {
                text: String::new(),
                reasoning: "need the file".to_owned(),
                calls: vec![Call {
                    id: "toolu_1".to_owned(),
                    name: "Read".to_owned(),
                    arguments: r#"{"file_path":"a.png"}"#.to_owned(),
                }],
            },
            // 工具结果紧跟调用；之后才是提醒、结果里的图片与这条 user 消息的其余内容。
            Item::ToolResult {
                call_id: "toolu_1".to_owned(),
                output: "line 1\nline 2".to_owned(),
            },
            Item::User(vec![
                reminder("late note"),
                Part::Image("data:image/png;base64,AAAA".to_owned()),
                Part::Text("thanks".to_owned()),
            ]),
            Item::Assistant {
                text: "It is a cat.".to_owned(),
                reasoning: String::new(),
                calls: Vec::new(),
            },
        ]
    );
}

#[test]
fn a_trailing_system_message_becomes_a_final_user_turn() {
    let lowered = items(
        Vec::new(),
        vec![
            message(ApiRole::User, vec![text("hi")]),
            message(ApiRole::Assistant, vec![text("hello")]),
            message(ApiRole::System, vec![text("env")]),
        ],
    )
    .unwrap();
    assert_eq!(
        lowered.last(),
        Some(&Item::User(vec![Part::Text(
            "<system-reminder>\nenv\n</system-reminder>".to_owned()
        )]))
    );
    // 没有 system 块时没有 System 项。
    assert!(!matches!(lowered.first(), Some(Item::System(_))));
}

#[test]
fn unmaterialized_images_are_rejected() {
    use nibi_kernel_api::ids::{ArtifactId, SessionId};
    use nibi_kernel_api::store::{ArtifactPurpose, ArtifactRef};
    let artifact = ImageSource::Artifact {
        media_type: "image/png".to_owned(),
        artifact: ArtifactRef {
            session: SessionId::new("s"),
            id: ArtifactId::new("a"),
            purpose: ArtifactPurpose::Media,
            media_type: "image/png".to_owned(),
            size: 4,
        },
    };
    let messages = vec![message(
        ApiRole::User,
        vec![ContentBlock::Image { source: artifact }],
    )];
    assert!(matches!(
        items(Vec::new(), messages),
        Err(ModelError::InvalidRequest { .. })
    ));
}

#[test]
fn tool_references_lower_to_text() {
    let conversation = vec![message(
        ApiRole::User,
        vec![ContentBlock::ToolResult {
            tool_use_id: ToolUseId::new("toolu_1"),
            content: vec![
                ToolResultContent::ToolReference {
                    tool_name: "WebFetch".to_owned(),
                },
                ToolResultContent::ToolReference {
                    tool_name: "WebSearch".to_owned(),
                },
            ],
            is_error: false,
        }],
    )];
    let lowered = items(Vec::new(), conversation).unwrap();
    assert_eq!(
        lowered,
        vec![Item::ToolResult {
            call_id: "toolu_1".to_owned(),
            output: "Tool loaded: WebFetch\nTool loaded: WebSearch".to_owned(),
        }]
    );
}

/// Read 整读 PDF 的 document 块（model.md §10.6，修复线 F24）：与结果里的图片一样放进紧随的 user 片段。
pub(crate) fn pdf_result() -> Vec<ApiMessage> {
    vec![message(
        ApiRole::User,
        vec![ContentBlock::ToolResult {
            tool_use_id: ToolUseId::new("toolu_1"),
            content: vec![
                ToolResultContent::Text {
                    text: "PDF file read: /w/doc.pdf (5 bytes)".to_owned(),
                },
                ToolResultContent::Document {
                    source: ImageSource::Base64 {
                        media_type: "application/pdf".to_owned(),
                        data: "JVBERi0=".to_owned(),
                    },
                },
            ],
            is_error: false,
        }],
    )]
}

#[test]
fn documents_lower_to_file_parts_after_the_tool_result() {
    assert_eq!(
        items(Vec::new(), pdf_result()).unwrap(),
        vec![
            Item::ToolResult {
                call_id: "toolu_1".to_owned(),
                output: "PDF file read: /w/doc.pdf (5 bytes)".to_owned(),
            },
            Item::User(vec![Part::File {
                url: "data:application/pdf;base64,JVBERi0=".to_owned(),
                name: None,
            }]),
        ]
    );
}

/// 用户贴的 PDF（消息级的 document 块）：与工具结果里的 document 同一条 `file` part，另带展示名。
#[test]
fn user_documents_lower_to_file_parts_with_their_name() {
    let messages = vec![message(
        ApiRole::User,
        vec![
            text("summarize this"),
            ContentBlock::Document {
                source: ImageSource::Base64 {
                    media_type: "application/pdf".to_owned(),
                    data: "JVBERi0=".to_owned(),
                },
                name: Some("paper.pdf".to_owned()),
            },
        ],
    )];
    assert_eq!(
        items(Vec::new(), messages).unwrap(),
        vec![Item::User(vec![
            // 消息级的块按原顺序（只有工具结果里的媒体才被提到 user 片段前面）。
            Part::Text("summarize this".to_owned()),
            Part::File {
                url: "data:application/pdf;base64,JVBERi0=".to_owned(),
                name: Some("paper.pdf".to_owned()),
            },
        ])]
    );
}

/// 用户贴的视频：Chat Completions 的 `video_url` 片段（Node `@ai-sdk/openai-compatible` 补丁同一形状）。
#[test]
fn user_videos_lower_to_video_url_parts() {
    let messages = vec![message(
        ApiRole::User,
        vec![
            text("what happens here"),
            ContentBlock::Video {
                source: ImageSource::Base64 {
                    media_type: "video/mp4".to_owned(),
                    data: "AAAAIGZ0eXA=".to_owned(),
                },
                name: Some("clip.mp4".to_owned()),
            },
        ],
    )];
    assert_eq!(
        items(Vec::new(), messages).unwrap(),
        vec![Item::User(vec![
            Part::Text("what happens here".to_owned()),
            Part::Video("data:video/mp4;base64,AAAAIGZ0eXA=".to_owned()),
        ])]
    );
}

/// Read 整读视频的结果：与图片一样挪进紧随的 user 片段（OpenAI 的 tool 消息只能放文本）。
#[test]
fn tool_result_videos_move_into_the_following_user_part() {
    let messages = vec![message(
        ApiRole::User,
        vec![ContentBlock::ToolResult {
            tool_use_id: ToolUseId::new("toolu_1"),
            content: vec![ToolResultContent::Video {
                source: ImageSource::Base64 {
                    media_type: "video/webm".to_owned(),
                    data: "AAAAIGZ0eXA=".to_owned(),
                },
            }],
            is_error: false,
        }],
    )];
    assert_eq!(
        items(Vec::new(), messages).unwrap(),
        vec![
            Item::ToolResult {
                call_id: "toolu_1".to_owned(),
                output: String::new(),
            },
            Item::User(vec![Part::Video(
                "data:video/webm;base64,AAAAIGZ0eXA=".to_owned()
            )]),
        ]
    );
}
