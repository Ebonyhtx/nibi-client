use nibi_kernel_api::automation::{AutomationCreate, AutomationMaxRuns, AutomationUpdate};
use nibi_kernel_api::cron_store::CronScheduleUnit;
use serde_json::json;

use super::{create_params, update_params};

#[test]
fn create_params_send_only_the_host_fields() {
    let params = create_params(&AutomationCreate {
        title: Some("每 31 小时".to_owned()),
        cron: "49 * * * *".to_owned(),
        prompt: "check".to_owned(),
        delay_minutes: None,
        model_selection: Some(json!({"providerId": "p", "modelId": "m"})),
        mode: Some("build".to_owned()),
        target_task_id: Some("sess_1".to_owned()),
        bot_delivery_target: None,
        recurring: true,
        max_runs: None,
        interval_unit: Some(CronScheduleUnit::Hourly),
        interval: Some(31),
    });
    assert_eq!(
        params,
        json!({
            "title": "每 31 小时",
            "cronExpr": "49 * * * *",
            "prompt": "check",
            "recurring": true,
            "modelSelection": {"providerId": "p", "modelId": "m"},
            "mode": "build",
            "targetTaskId": "sess_1",
            "intervalUnit": "hourly",
            "interval": 31,
        })
    );
}

#[test]
fn update_params_distinguish_keep_clear_and_set_max_runs() {
    let base = AutomationUpdate {
        automation_id: "auto-1".to_owned(),
        title: None,
        cron: None,
        prompt: None,
        recurring: None,
        max_runs: AutomationMaxRuns::Keep,
        interval_unit: None,
        interval: None,
    };
    assert_eq!(update_params(&base), json!({"automationId": "auto-1"}));
    assert_eq!(
        update_params(&AutomationUpdate {
            max_runs: AutomationMaxRuns::Clear,
            recurring: Some(true),
            ..base.clone()
        }),
        json!({"automationId": "auto-1", "recurring": true, "maxRuns": null})
    );
    assert_eq!(
        update_params(&AutomationUpdate {
            max_runs: AutomationMaxRuns::Set(3),
            ..base
        }),
        json!({"automationId": "auto-1", "maxRuns": 3})
    );
}

/// 反向请求的真实链路：HostAutomation 写出的帧能被对端读到，对端的回复能回到等待者。
#[tokio::test]
async fn host_automation_sends_the_request_and_parses_the_reply() {
    use std::sync::Arc;

    use async_trait::async_trait;
    use nibi_kernel_api::automation::AutomationPort;
    use nibi_kernel_api::testing::FixedClock;
    use nibi_kernel_base::TaskScope;
    use nibi_kernel_protocol_core::connection::{self, Options, Reply, Service};
    use nibi_kernel_protocol_core::rpc::RpcError;
    use serde_json::{Value, json};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, duplex};

    struct Noop;

    #[async_trait]
    impl Service for Noop {
        async fn request(&self, method: &str, _params: Value) -> Result<Reply, RpcError> {
            Err(RpcError::method_not_found(method))
        }
    }

    let scope = TaskScope::root("automation-test", |_| {});
    let (mut to_kernel, kernel_in) = duplex(1 << 20);
    let (kernel_out, from_kernel) = duplex(1 << 20);
    let (peer, _writer) = connection::start(kernel_out, &scope.spawner(), Options::default());
    let spawner = scope.spawner();
    let _serve = scope.spawner().spawn(
        "serve",
        connection::serve(
            BufReader::new(kernel_in),
            peer.clone(),
            Arc::new(Noop),
            spawner,
            Options::default(),
        ),
    );
    let host =
        super::HostAutomation::new(Arc::new(super::Context::new(peer, Arc::new(FixedClock(0)))));
    let pending = tokio::spawn(async move {
        host.create(AutomationCreate {
            title: Some("每 5 分钟".to_owned()),
            cron: "*/5 * * * *".to_owned(),
            prompt: "check".to_owned(),
            delay_minutes: None,
            model_selection: None,
            mode: Some("build".to_owned()),
            target_task_id: Some("sess_1".to_owned()),
            bot_delivery_target: None,
            recurring: true,
            max_runs: None,
            interval_unit: None,
            interval: None,
        })
        .await
    });
    let mut from_kernel = BufReader::new(from_kernel).lines();
    let line = tokio::time::timeout(std::time::Duration::from_secs(5), from_kernel.next_line())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let request: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(request["method"], "automation/create");
    assert_eq!(request["params"]["cronExpr"], "*/5 * * * *");
    assert_eq!(request["params"]["targetTaskId"], "sess_1");
    let id = request["id"].clone();
    let record = json!({
        "automationId": "auto-1",
        "title": "每 5 分钟",
        "cronExpr": "*/5 * * * *",
        "prompt": "check",
        "enabled": true,
        "lifecycleStatus": "active",
        "runCount": 0,
        "recurring": true,
    });
    let response = json!({"id": id, "result": {"automation": record}});
    to_kernel
        .write_all(format!("{response}\n").as_bytes())
        .await
        .unwrap();
    let created = pending.await.unwrap().unwrap();
    assert_eq!(created.automation_id, "auto-1");
    assert_eq!(
        created.target_task_id, None,
        "record has no targetTaskId in this fixture"
    );
}
