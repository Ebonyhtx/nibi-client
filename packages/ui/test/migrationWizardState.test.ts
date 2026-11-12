import { describe, expect, it } from "vitest";
import type { SettingsSyncImportResult } from "@nibi/shared";
import {
  aggregateSettingsImportResult,
  buildMigrationWizardSelectionSummary,
  canCloseMigrationWizard,
  collectSettingsFailureDetails,
  getMigrationWizardFooterSelectionCount,
  getMigrationWizardInfoNoticeIds,
  getMigrationWizardStepDescriptionId,
  getMigrationWizardUnsupportedNoticeId,
  getNextMigrationWizardStep,
  getPreviousMigrationWizardStep,
  groupSessionCandidatesByWorkspace,
  MIGRATION_WIZARD_STEP_ORDER,
  resolveAgentsFileOutcome,
  resolveMigrationWizardFooterState,
  resolveMigrationWizardProgress,
} from "@/settings/migration-wizard/migrationWizardState.js";

describe("迁移向导步骤推进", () => {
  it("六步顺序固定为 会话 → Skills → MCP → 命令 → AGENTS.md → 迁移", () => {
    expect(MIGRATION_WIZARD_STEP_ORDER).toEqual([
      "session",
      "skills",
      "mcp",
      "commands",
      "agentsFile",
      "migration",
    ]);
  });

  it("可以从第一步逐步推进到最后一步，并在末步停止", () => {
    let step = MIGRATION_WIZARD_STEP_ORDER[0];
    const visited = [step];

    for (let index = 1; index < MIGRATION_WIZARD_STEP_ORDER.length; index += 1) {
      step = getNextMigrationWizardStep(step)!;
      visited.push(step);
    }

    expect(visited).toEqual([...MIGRATION_WIZARD_STEP_ORDER]);
    expect(getNextMigrationWizardStep("migration")).toBeNull();
  });

  it("可以从末步回退到第一步，并在第一步停止", () => {
    let step = MIGRATION_WIZARD_STEP_ORDER[MIGRATION_WIZARD_STEP_ORDER.length - 1];
    const visited = [step];

    while (true) {
      const previous = getPreviousMigrationWizardStep(step);
      if (!previous) {
        break;
      }
      step = previous;
      visited.push(step);
    }

    expect(visited).toEqual([...MIGRATION_WIZARD_STEP_ORDER].reverse());
    expect(getPreviousMigrationWizardStep("session")).toBeNull();
  });

  it("每一步都有独立的标题与说明文案 id", () => {
    for (const step of MIGRATION_WIZARD_STEP_ORDER) {
      expect(getMigrationWizardStepDescriptionId(step)).toMatch(
        /^settings\.dataSync\.migration\.stepDescription\./u,
      );
    }
  });
});

describe("无选择时继续", () => {
  it("非末步即使没有任何选择，继续按钮仍可用", () => {
    for (const step of MIGRATION_WIZARD_STEP_ORDER) {
      if (step === "migration") {
        continue;
      }
      const footer = resolveMigrationWizardFooterState({
        step,
        running: false,
        finished: false,
        canStart: false,
      });
      expect(footer.primaryAction).toBe("continue");
      expect(footer.primaryDisabled).toBe(false);
      expect(footer.cancelDisabled).toBe(false);
    }
  });

  it("末步至少有一项选择才允许开始迁移", () => {
    expect(
      resolveMigrationWizardFooterState({
        step: "migration",
        running: false,
        finished: false,
        canStart: false,
      }).primaryDisabled,
    ).toBe(true);
    expect(
      resolveMigrationWizardFooterState({
        step: "migration",
        running: false,
        finished: false,
        canStart: true,
      }).primaryDisabled,
    ).toBe(false);
  });
});

describe("末步聚合汇总", () => {
  it("同时统计工作区、外部导入项与 AGENTS.md", () => {
    const summary = buildMigrationWizardSelectionSummary({
      selectedWorkspacePaths: ["/repo/a", "/repo/b"],
      skillsCount: 3,
      mcpCount: 2,
      commandsCount: 1,
      agentsFileSelected: true,
    });

    expect(summary.workspaceCount).toBe(2);
    expect(summary.externalItemCount).toBe(6);
    expect(summary.agentsFileCount).toBe(1);
    expect(summary.totalItemCount).toBe(7);
    expect(summary.canStart).toBe(true);
  });

  it("只有 AGENTS.md 一项也可开始迁移", () => {
    const summary = buildMigrationWizardSelectionSummary({
      selectedWorkspacePaths: [],
      skillsCount: 0,
      mcpCount: 0,
      commandsCount: 0,
      agentsFileSelected: true,
    });

    expect(summary.canStart).toBe(true);
    expect(summary.totalItemCount).toBe(1);
  });

  it("全部为空时不允许开始迁移", () => {
    const summary = buildMigrationWizardSelectionSummary({
      selectedWorkspacePaths: [],
      skillsCount: 0,
      mcpCount: 0,
      commandsCount: 0,
      agentsFileSelected: false,
    });

    expect(summary.canStart).toBe(false);
    expect(summary.totalItemCount).toBe(0);
  });

  it("第一步底部统计工作区，其余步骤统计导入项", () => {
    const summary = buildMigrationWizardSelectionSummary({
      selectedWorkspacePaths: ["/repo/a"],
      skillsCount: 2,
      mcpCount: 1,
      commandsCount: 1,
      agentsFileSelected: true,
    });

    expect(getMigrationWizardFooterSelectionCount("session", summary)).toBe(1);
    expect(getMigrationWizardFooterSelectionCount("skills", summary)).toBe(6);
  });

  it("按类别汇总设置导入结果", () => {
    const result: SettingsSyncImportResult = {
      successCount: 5,
      skippedCount: 2,
      failedCount: 1,
      taskResults: [
        {
          agent: "claudeCode",
          category: "skills",
          status: "success",
          importedCount: 3,
          skippedCount: 0,
          failedCount: 0,
        },
        {
          agent: "claudeCode",
          category: "mcpServers",
          status: "success",
          importedCount: 1,
          skippedCount: 1,
          failedCount: 0,
        },
        {
          agent: "codexCli",
          category: "commands",
          status: "failed",
          importedCount: 1,
          skippedCount: 1,
          failedCount: 1,
        },
        {
          agent: "claudeCode",
          category: "plugins",
          status: "success",
          importedCount: 9,
          skippedCount: 0,
          failedCount: 0,
        },
      ],
    };

    const summary = aggregateSettingsImportResult(result);

    expect(summary.skills).toEqual({ imported: 3, skipped: 0, failed: 0 });
    expect(summary.mcpServers).toEqual({ imported: 1, skipped: 1, failed: 0 });
    expect(summary.commands).toEqual({ imported: 1, skipped: 1, failed: 1 });
  });

  it("AGENTS.md 结果按复制/跳过/失败/未选择归类", () => {
    expect(
      resolveAgentsFileOutcome({
        selected: false,
        importedCount: 0,
        skippedCount: 0,
        failedCount: 0,
      }),
    ).toBe("notSelected");
    expect(
      resolveAgentsFileOutcome({
        selected: true,
        importedCount: 1,
        skippedCount: 0,
        failedCount: 0,
      }),
    ).toBe("copied");
    expect(
      resolveAgentsFileOutcome({
        selected: true,
        importedCount: 0,
        skippedCount: 1,
        failedCount: 0,
      }),
    ).toBe("skipped");
    expect(
      resolveAgentsFileOutcome({
        selected: true,
        importedCount: 0,
        skippedCount: 0,
        failedCount: 1,
      }),
    ).toBe("failed");
  });

  it("收集设置导入的失败明细", () => {
    const result: SettingsSyncImportResult = {
      successCount: 0,
      skippedCount: 0,
      failedCount: 1,
      taskResults: [
        {
          agent: "claudeCode",
          category: "skills",
          status: "failed",
          importedCount: 0,
          skippedCount: 0,
          failedCount: 1,
          skillResults: [
            {
              name: "broken-skill",
              path: "/home/me/.claude/skills/broken-skill",
              sourceScope: "global",
              status: "failed",
            },
            {
              name: "ok-skill",
              path: "/home/me/.claude/skills/ok-skill",
              sourceScope: "global",
              status: "imported",
            },
          ],
        },
      ],
    };

    expect(collectSettingsFailureDetails(result)).toEqual([
      {
        category: "skills",
        label: "broken-skill",
        reason: "/home/me/.claude/skills/broken-skill",
      },
    ]);
  });
});

describe("不可用能力文案", () => {
  it("非桌面端对每一步都给出桌面端限制说明", () => {
    for (const step of MIGRATION_WIZARD_STEP_ORDER) {
      expect(
        getMigrationWizardUnsupportedNoticeId(step, {
          isDesktop: false,
          agentsFileLoading: false,
          agentsFileSupported: false,
        }),
      ).toBe("settings.dataSync.migration.notice.unsupportedDesktopOnly");
    }
  });

  it("桌面端缺少 CLAUDE.md 时 AGENTS.md 步骤给出缺失说明", () => {
    expect(
      getMigrationWizardUnsupportedNoticeId("agentsFile", {
        isDesktop: true,
        agentsFileLoading: false,
        agentsFileSupported: false,
      }),
    ).toBe("settings.dataSync.migration.agentsFile.missingSource");
    expect(
      getMigrationWizardUnsupportedNoticeId("agentsFile", {
        isDesktop: true,
        agentsFileLoading: true,
        agentsFileSupported: false,
      }),
    ).toBeNull();
    expect(
      getMigrationWizardUnsupportedNoticeId("agentsFile", {
        isDesktop: true,
        agentsFileLoading: false,
        agentsFileSupported: true,
      }),
    ).toBeNull();
  });

  it("显式标注插件不可用、MCP 来源与非 Claude 会话限制", () => {
    expect(getMigrationWizardInfoNoticeIds("session")).toContain(
      "settings.dataSync.migration.notice.sessionClaudeOnly",
    );
    expect(getMigrationWizardInfoNoticeIds("skills")).toContain(
      "settings.dataSync.migration.notice.skillsPluginsUnavailable",
    );
    expect(getMigrationWizardInfoNoticeIds("mcp")).toContain(
      "settings.dataSync.migration.notice.mcpSources",
    );
  });
});

describe("执行中禁用", () => {
  it("执行中禁用取消、关闭与步骤回看", () => {
    const footer = resolveMigrationWizardFooterState({
      step: "migration",
      running: true,
      finished: false,
      canStart: true,
    });

    expect(footer.cancelDisabled).toBe(true);
    expect(footer.navigationDisabled).toBe(true);
    expect(footer.primaryDisabled).toBe(true);
    expect(canCloseMigrationWizard(true)).toBe(false);
    expect(canCloseMigrationWizard(false)).toBe(true);
  });

  it("完成后主按钮变为“完成”，可以关闭", () => {
    const footer = resolveMigrationWizardFooterState({
      step: "migration",
      running: false,
      finished: true,
      canStart: true,
    });

    expect(footer.primaryAction).toBe("finish");
    expect(footer.primaryDisabled).toBe(false);
    expect(footer.cancelDisabled).toBe(false);
  });

  it("进度按会话工作区、AGENTS.md、外部导入三个执行阶段计算", () => {
    expect(
      resolveMigrationWizardProgress({
        sessionCompletedCount: 1,
        sessionTotalCount: 2,
        agentsFileSelected: true,
        agentsFileCompleted: false,
        externalImportSelected: true,
        externalImportCompleted: false,
        finished: false,
      }),
    ).toBe(25);
    expect(
      resolveMigrationWizardProgress({
        sessionCompletedCount: 2,
        sessionTotalCount: 2,
        agentsFileSelected: true,
        agentsFileCompleted: true,
        externalImportSelected: true,
        externalImportCompleted: true,
        finished: true,
      }),
    ).toBe(100);
  });
});

describe("会话候选按工作区分组", () => {
  it("按 workspacePath 聚合会话数，并按会话数降序排列", () => {
    expect(
      groupSessionCandidatesByWorkspace([
        { workspacePath: "/repo/a" },
        { workspacePath: "/repo/b" },
        { workspacePath: "/repo/a" },
        { workspacePath: "/repo/c" },
        { workspacePath: "/repo/a" },
        { workspacePath: "/repo/b" },
      ]),
    ).toEqual([
      { workspacePath: "/repo/a", label: "a", sessionCount: 3 },
      { workspacePath: "/repo/b", label: "b", sessionCount: 2 },
      { workspacePath: "/repo/c", label: "c", sessionCount: 1 },
    ]);
  });
});
