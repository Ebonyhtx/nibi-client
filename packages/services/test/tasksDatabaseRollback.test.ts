import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { AutomationRepo } from "../src/session/automationRepo.js";
import { runTasksDatabaseMigrations } from "../src/session/tasksDatabase/migrations.js";
import {
  rowToAutomation as oldAutomation,
  rowToRun as oldRun,
} from "./fixtures/staging-backup-task-readers.mjs";

it("DB109-01/09/10/13：八表内容保留，旧版读取新增/更新任务无需模型双写，再升级不补迁", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-db109-rollback-"));
  const path = join(root, "tasks.sqlite");
  const automation = new AutomationRepo(path);
  const db = new DatabaseSync(path);
  try {
    await runTasksDatabaseMigrations(db, path);
    db.exec(`DELETE FROM tasks_schema_migration WHERE id='0002_provider_selection';
      INSERT INTO tasks(workspace_key,workspace_path,workspace_identity,task_id,title,created_at,updated_at,meta_json)
      VALUES('ssh:a:/same','/same','ssh:a:/same','session','旧会话标题',1,2,'{"unknown":"附件引用"}');
      INSERT INTO task_groups VALUES('group','分组','gray',1,2);
      INSERT INTO task_group_members VALUES('group','ssh:a:/same','/same','ssh:a:/same','session',1,1,1,2);
      INSERT INTO task_group_view_node_orders VALUES('task','session',1,1,2);
      INSERT INTO task_group_workspace_bootstraps VALUES('ssh:a:/same','group',1,2);
      INSERT INTO automations(automation_id,cron_expr,prompt,workspace_key,workspace_path,created_at,updated_at,model,provider,thought_level)
      VALUES('old','* * * * *','定时正文','ssh:a:/same','/same',1,2,'custom:proxy:old','zcode','high');
      INSERT INTO automation_runs(run_id,automation_id,workspace_key,created_at,updated_at,session_id) VALUES('run','old','ssh:a:/same',1,2,'session');`);
    const preservedTables = [
      "tasks",
      "task_groups",
      "task_group_members",
      "task_group_view_node_orders",
      "task_group_workspace_bootstraps",
      "automation_runs",
    ];
    const before = preservedTables.map((table) => db.prepare(`SELECT * FROM ${table}`).all());
    await runTasksDatabaseMigrations(db, path);
    expect(preservedTables.map((table) => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(
      before,
    );
    expect(
      oldAutomation(db.prepare("SELECT * FROM automations WHERE automation_id='old'").get()).prompt,
    ).toBe("定时正文");
    expect(oldRun(db.prepare("SELECT * FROM automation_runs").get()).sessionId).toBe("session");

    const selection = { providerId: "proxy", modelId: "next", options: { reasoningLevel: "high" } };
    const task = await automation.create(
      {
        title: "新任务",
        cronExpr: "* * * * *",
        prompt: "新定时正文",
        workspacePath: "/new",
        modelSelection: selection,
      },
      { nextRunAt: 50 },
    );
    const rawTask = db
      .prepare("SELECT * FROM automations WHERE automation_id=?")
      .get(task.automationId)!;
    expect(rawTask.model).toBeNull();
    expect(oldAutomation(rawTask).prompt).toBe("新定时正文");

    // 模拟回滚后的旧 Writer 更新，保留一次迁移账本；再升级不能拿旧选择恢复默认执行。
    automation.close();
    const ledger = db.prepare("SELECT * FROM tasks_schema_migration").all();
    db.exec(
      "UPDATE automations SET model_selection=NULL,model='old-after-rollback',prompt='回滚后的正文' WHERE automation_id='old'",
    );
    expect((await automation.get("old"))?.prompt).toBe("回滚后的正文");
    await expect(automation.getModelSelectionForDispatch("old", "ssh:a:/same")).rejects.toThrow(
      "重新选择",
    );
    expect(db.prepare("SELECT * FROM tasks_schema_migration").all()).toEqual(ledger);
  } finally {
    automation.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
