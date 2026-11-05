//! 人类输入里的图片（docs/specs/rust-cli/tui-input.md §3.2）：写成 Node `file` part（data URL），冷读取按 part
//! 顺序还原成 image 块。
use nibi_kernel_api::ids::{MessageId, SessionId};
use nibi_kernel_api::message::{ContentBlock, ImageSource, Message, UserMessage, UserOrigin};
use nibi_kernel_api::store::{Fact, SessionStore};
use serde_json::Value;

use crate::tests::{TestStore, batch, started};

#[tokio::test]
async fn pasted_images_round_trip_as_node_file_parts() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    let image = ContentBlock::Image {
        source: ImageSource::Base64 {
            media_type: "image/png".into(),
            data: "iVBORw0KGgo=".into(),
        },
    };
    let message = Message::User(UserMessage {
        id: MessageId::new("msg_ru_u1"),
        content: vec![
            ContentBlock::Text {
                text: "what is this [Image #1]".into(),
            },
            image,
        ],
        origin: UserOrigin::Human,
    });
    let fact = Fact::MessageAppended {
        message: message.clone(),
    };
    t.store
        .commit(&SessionId::new("sess_1"), batch(Some("cmd"), vec![fact]))
        .await
        .unwrap();
    let parts = t.rows("select data from part where message_id = 'msg_ru_u1' order by sequence");
    let file: Value = parts
        .iter()
        .filter_map(|row| row[0].as_str())
        .map(|data| serde_json::from_str::<Value>(data).unwrap())
        .find(|part| part["type"] == "file")
        .expect("a file part");
    assert_eq!(file["mime"], "image/png");
    assert_eq!(file["url"], "data:image/png;base64,iVBORw0KGgo=");
    assert_eq!(file["metadata"]["storageKind"], "inline");
    let loaded = t.store.load(&SessionId::new("sess_1")).await.unwrap();
    assert_eq!(loaded.messages, vec![message]);
    // 标题只取文字。
    assert_eq!(loaded.meta.title, "what is this [Image #1]");
}

/// 用户贴的 PDF（Node `file` part，mime 是 `application/pdf`）：写成同一条 `file` part，`filename` 落
/// `filename`，冷读取还原成 document 块（与 `filePartToContentBlock` 的 PDF 分支同形）。
#[tokio::test]
async fn pasted_pdfs_round_trip_as_node_file_parts() {
    let t = TestStore::new();
    started(&t, "sess_1").await;
    let document = ContentBlock::Document {
        source: ImageSource::Base64 {
            media_type: "application/pdf".into(),
            data: "JVBERi0xLjQ=".into(),
        },
        name: Some("paper.pdf".into()),
    };
    let message = Message::User(UserMessage {
        id: MessageId::new("msg_ru_u1"),
        content: vec![
            ContentBlock::Text {
                text: "summarize this".into(),
            },
            document,
        ],
        origin: UserOrigin::Human,
    });
    t.store
        .commit(
            &SessionId::new("sess_1"),
            batch(
                Some("cmd"),
                vec![Fact::MessageAppended {
                    message: message.clone(),
                }],
            ),
        )
        .await
        .unwrap();
    let parts = t.rows("select data from part where message_id = 'msg_ru_u1' order by sequence");
    let file: Value = parts
        .iter()
        .filter_map(|row| row[0].as_str())
        .map(|data| serde_json::from_str::<Value>(data).unwrap())
        .find(|part| part["type"] == "file")
        .expect("a file part");
    assert_eq!(file["mime"], "application/pdf");
    assert_eq!(file["filename"], "paper.pdf");
    assert_eq!(file["url"], "data:application/pdf;base64,JVBERi0xLjQ=");
    let loaded = t.store.load(&SessionId::new("sess_1")).await.unwrap();
    assert_eq!(loaded.messages, vec![message]);
}

/// 带内容块的 attachment（tui-input.md §1.3、node-store.md §4.5）：内容块写成同一条合成消息里 text part 之后的
/// part（文字块是 synthetic text part，图片是 Node `file` part），`rustCli.data` 不重复存；冷读取按 part 顺序还原。
#[tokio::test]
async fn attachment_blocks_round_trip_as_parts_after_the_text() {
    use nibi_kernel_api::message::{ATTACHMENT_BLOCKS, AttachmentMessage};
    use serde_json::json;

    let t = TestStore::new();
    started(&t, "sess_1").await;
    let image = ContentBlock::Image {
        source: ImageSource::Base64 {
            media_type: "image/png".into(),
            data: "iVBORw0KGgo=".into(),
        },
    };
    let cell = ContentBlock::Text {
        text: "<system-reminder>\n<cell id=\"p\">show()</cell id=\"p\">\n</system-reminder>".into(),
    };
    let human = Message::User(UserMessage {
        id: MessageId::new("msg_ru_u1"),
        content: vec![ContentBlock::Text {
            text: "look at @plot.ipynb".into(),
        }],
        origin: UserOrigin::Human,
    });
    let attachment = Message::Attachment(AttachmentMessage {
        id: MessageId::new("msg_rv_a1"),
        source: "file".into(),
        text: "<system-reminder>\nCalled the Read tool with the following input: {\"file_path\":\"/w/plot.ipynb\"}\n</system-reminder>".into(),
        data: json!({
            "filename": "/w/plot.ipynb",
            "displayPath": "plot.ipynb",
            ATTACHMENT_BLOCKS: [cell.clone(), image.clone()],
        }),
    });
    let facts = [human.clone(), attachment.clone()]
        .into_iter()
        .map(|message| Fact::MessageAppended { message })
        .collect();
    t.store
        .commit(&SessionId::new("sess_1"), batch(Some("cmd"), facts))
        .await
        .unwrap();
    let parts: Vec<Value> = t
        .rows("select data from part where message_id = 'msg_rv_a1' order by sequence")
        .iter()
        .filter_map(|row| row[0].as_str())
        .map(|data| serde_json::from_str(data).unwrap())
        .collect();
    let kinds: Vec<&str> = parts
        .iter()
        .filter_map(|part| part["type"].as_str())
        .collect();
    assert_eq!(kinds, ["text", "text", "file"]);
    assert_eq!(parts[0]["metadata"]["rustCli"]["message"], "attachment");
    assert_eq!(
        parts[0]["metadata"]["rustCli"]["data"],
        json!({"filename": "/w/plot.ipynb", "displayPath": "plot.ipynb"})
    );
    assert_eq!(parts[1]["synthetic"], true);
    assert_eq!(parts[1]["metadata"]["source"], "file");
    assert_eq!(parts[2]["url"], "data:image/png;base64,iVBORw0KGgo=");
    let loaded = t.store.load(&SessionId::new("sess_1")).await.unwrap();
    assert_eq!(loaded.messages, vec![human, attachment]);
}
