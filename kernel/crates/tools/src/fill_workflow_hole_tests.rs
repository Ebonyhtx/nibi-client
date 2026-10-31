//! 纯函数面的单测：铸名、模型面路径写法与确认前的等待判定。工具的调用链依赖 sidecar 引擎
//! （`WorkflowEngine::fill_target` / `fill_hole`），走 DWF 门禁对拍（scripts/kernel-baseline/
//! check-dwf-engine.mjs 的 dwfHole 阶段），不在这里造假引擎。

use super::{
    compile_failure_text, describe_workflow_script_path, refusal_text, waiting_check,
    workflow_draft_slug,
};
use rust_cli_kernel_api::workflow::{WorkflowFillDiagnostic, WorkflowFillTarget, WorkflowFillTargetHole};

#[test]
fn slug_follows_the_node_rule() {
    assert_eq!(workflow_draft_slug("fill the verdict"), "fill-the-verdict");
    assert_eq!(workflow_draft_slug("  决定 分组  "), "决定-分组");
    assert_eq!(workflow_draft_slug("a/b\\c:d"), "abcd");
    assert_eq!(workflow_draft_slug(""), "workflow");
    assert_eq!(workflow_draft_slug("..."), "workflow");
    assert_eq!(workflow_draft_slug("-.-"), "workflow");
    // 码点截断在 64，尾部再修剪。
    let long = "x".repeat(70);
    assert_eq!(workflow_draft_slug(&long), "x".repeat(64));
    let long_tail = format!("{}..", "y".repeat(70));
    assert_eq!(workflow_draft_slug(&long_tail), "y".repeat(64));
}

#[test]
fn describe_path_prefers_workspace_relative() {
    assert_eq!(
        describe_workflow_script_path("/ws/.nibi/workflow-drafts/holeprobe.dwf.ts", "/ws"),
        ".nibi/workflow-drafts/holeprobe.dwf.ts"
    );
    // 目录外的兄弟路径退回绝对。
    assert_eq!(describe_workflow_script_path("/other/x.dwf.ts", "/ws"), "/other/x.dwf.ts");
    // 路径等于工作目录：空串不是一个能 Edit 的文件名。
    assert_eq!(describe_workflow_script_path("/ws", "/ws"), "/ws");
    // Windows 同盘符相对化、跨盘退回绝对，分隔符统一 `/`。
    assert_eq!(
        describe_workflow_script_path(r"C:\ws\.nibi\workflow-drafts\a.dwf.ts", r"C:\ws"),
        ".nibi/workflow-drafts/a.dwf.ts"
    );
    assert_eq!(
        describe_workflow_script_path(r"D:\other\a.dwf.ts", r"C:\ws"),
        r"D:\other\a.dwf.ts"
    );
}

fn target(status: &str, holes: Vec<WorkflowFillTargetHole>) -> WorkflowFillTarget {
    WorkflowFillTarget {
        name: Some("holeprobe".to_owned()),
        draft_path: None,
        status: status.to_owned(),
        stop_reason: None,
        holes,
    }
}

fn waiting_hole() -> WorkflowFillTargetHole {
    WorkflowFillTargetHole {
        site_id: "hole#21b40fca".to_owned(),
        name: "fill the verdict".to_owned(),
        hole_type: "string".to_owned(),
        line: Some(4),
        waiting: true,
    }
}

#[test]
fn waiting_check_matches_the_node_tree() {
    // 在等：None（放行）。
    assert!(waiting_check(&target("running", vec![waiting_hole()]), "r", "hole#21b40fca").is_none());
    // 停了：指向 ResumeWorkflowRun。
    let mut stopped = target("stopped", vec![waiting_hole()]);
    stopped.stop_reason = Some("user".to_owned());
    let refusal = waiting_check(&stopped, "r", "hole#21b40fca").unwrap();
    assert!(refusal.starts_with("hole_not_waiting: run r is stopped (user)"));
    assert!(refusal.ends_with("Nothing was filled."));
    // 终态。
    assert!(
        waiting_check(&target("completed", vec![waiting_hole()]), "r", "hole#21b40fca")
            .unwrap()
            .contains("has already completed")
    );
    // 未知 id。
    assert!(
        waiting_check(&target("running", vec![]), "r", "hole#zz").unwrap().contains(
            "no hole with that id has been reached"
        )
    );
    // 已补过。
    let mut filled = waiting_hole();
    filled.waiting = false;
    let refusal = waiting_check(&target("running", vec![filled]), "r", "hole#21b40fca").unwrap();
    assert!(refusal.contains("is already filled"));
}

#[test]
fn refusal_texts_keep_the_node_prefixes() {
    assert!(refusal_text("hole_not_waiting", "it is busy", "r").starts_with("hole_not_waiting: it is busy"));
    assert!(refusal_text("fill_ids_unstable", "detail", "r").contains("This is a host fault"));
    assert!(refusal_text("run_not_found", "ignored", "r42").contains("run_not_found: no workflow run with ID r42"));
    assert!(refusal_text("other", "boom", "r").starts_with("workflow_fill_refused: boom (reason: other)"));
}

#[test]
fn compile_failure_anchors_diagnostics_to_their_file() {
    let diagnostics = vec![
        WorkflowFillDiagnostic {
            line: 2,
            column: 3,
            message: "type mismatch".to_owned(),
            code: 2322,
            in_fill: true,
        },
        WorkflowFillDiagnostic {
            line: 1,
            column: 1,
            message: "outside".to_owned(),
            code: 9005,
            in_fill: false,
        },
    ];
    let text = compile_failure_text(
        "r",
        "hole#21b40fca",
        &diagnostics,
        Some((".nibi/workflow-drafts/r.hole.dwf.ts", true)),
        Some("holeprobe.dwf.ts"),
    );
    // lead 按「本次内联刚铸的 draft」分句；inFill 的诊断锚 fill 文件，体外的锚 run 草稿。
    assert!(text.starts_with("The fill is saved at .nibi/workflow-drafts/r.hole.dwf.ts."));
    assert!(text.contains(".nibi/workflow-drafts/r.hole.dwf.ts:L2:C3 type mismatch"));
    assert!(text.contains("holeprobe.dwf.ts:L1:C1 outside"));
    assert!(text.contains("The lines outside the fill are in the run's recorded script (holeprobe.dwf.ts as the run launched it)"));
    assert!(text.ends_with("NOTE: Nothing was spliced or journaled — hole hole#21b40fca of run r is still waiting for its body."));
    // `path` 提交的 lead 是「The fill file is」。
    let path_lead = compile_failure_text("r", "h", &diagnostics[..1], Some(("fill.dwf.ts", false)), None);
    assert!(path_lead.starts_with("The fill file is fill.dwf.ts."));
    // 写不成 fill 文件时的 lead。
    let none_lead = compile_failure_text("r", "h", &diagnostics[..1], None, None);
    assert!(none_lead.starts_with("The fill could not be saved to a file;"));
}
