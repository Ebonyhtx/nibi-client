//! MCP Apps 采样的模型端：一次性的回合外请求。

use std::sync::Arc;

use rust_cli_kernel_api::mcp_ui::{McpUiSamplingContent, McpUiSamplingInput, McpUiSamplingMessage};
use rust_cli_kernel_api::message::{ContentBlock, ImageSource};
use rust_cli_kernel_api::model::{ApiRole, ModelPort};
use rust_cli_kernel_api::testing::{ScriptedModel, selection, text_response};

use super::*;

#[tokio::test]
async fn sampling_builds_a_one_shot_request_and_returns_the_text() {
    let model = Arc::new(ScriptedModel::new(vec![text_response(&[
        "hello ", "world",
    ])]));
    let port: Arc<dyn ModelPort> = model.clone();
    let sampling = KernelSampling::new(
        port,
        selection(),
        Arc::new(rust_cli_kernel_api::testing::FixedClock(0)),
        Arc::new(rust_cli_kernel_api::testing::SequentialIds::default()),
        OpenSessions::default(),
        Arc::new(rust_cli_kernel_api::testing::MemoryStore::default()),
    );
    let result = sampling
        .sample(
            McpUiSamplingInput {
                messages: vec![
                    McpUiSamplingMessage {
                        role: "user".to_owned(),
                        content: vec![
                            McpUiSamplingContent::Text {
                                text: "hi".to_owned(),
                            },
                            McpUiSamplingContent::Image {
                                mime_type: "image/png".to_owned(),
                                data: "aGk=".to_owned(),
                            },
                        ],
                    },
                    McpUiSamplingMessage {
                        role: "assistant".to_owned(),
                        content: vec![McpUiSamplingContent::Text {
                            text: "hello".to_owned(),
                        }],
                    },
                ],
                system_prompt: Some("be brief".to_owned()),
                max_tokens: 64,
                selection: None,
                session: None,
            },
            CancellationToken::new(),
        )
        .await
        .expect("sampled");
    assert_eq!(result.model, "scripted");
    assert_eq!(result.text, "hello world");
    assert_eq!(result.stop_reason, "endTurn");
    let requests = model.requests();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request.max_tokens, 64);
    assert_eq!(
        request.options.provider_max_output_tokens,
        Some(64),
        "the provider patch must cap at the page's maxTokens"
    );
    assert_eq!(request.system[0].text, "be brief");
    assert_eq!(request.source.node_name(), "mcp_app_sampling");
    assert_eq!(request.messages[0].role, ApiRole::User);
    assert_eq!(
        request.messages[0].content[0].block,
        ContentBlock::Text {
            text: "hi".to_owned()
        }
    );
    assert_eq!(
        request.messages[0].content[1].block,
        ContentBlock::Image {
            source: ImageSource::Base64 {
                media_type: "image/png".to_owned(),
                data: "aGk=".to_owned(),
            }
        }
    );
    assert_eq!(request.messages[1].role, ApiRole::Assistant);
    assert!(request.tools.is_empty());
}
