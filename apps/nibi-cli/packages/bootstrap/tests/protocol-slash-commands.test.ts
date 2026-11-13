import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveNibiBuiltinPromptCommand } from "../src/builtin-prompt-command.js";
import { resolveNibiCustomCommandPrompt } from "../src/custom-command-prompt.js";
import { listProtocolSlashCommands } from "../src/nibi-protocol/slash-commands.js";

describe("protocol slash command surface", () => {
  it("returns app-supported builtins plus agent-discovered custom commands", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "nibi-protocol-slash-"));
    const workspace = join(tempRoot, "workspace");
    const home = join(tempRoot, "home");
    const projectCommands = join(workspace, ".nibi", "commands");
    const userCommands = join(home, ".nibi", "commands");

    try {
      await mkdir(projectCommands, { recursive: true });
      await mkdir(userCommands, { recursive: true });
      await writeCommand(projectCommands, "review", "Project review", "Project body.");
      await writeCommand(userCommands, "review", "User review", "User body.");
      await writeCommand(userCommands, "ship", "Ship changes", "Ship $ARGUMENTS.", [
        "argument-hint: [target]",
      ]);
      await writeCommand(userCommands, "model", "Reserved custom model", "Should be hidden.");
      await writeCommand(userCommands, "plan", "Reserved custom plan", "Should be hidden.");
      await writeCommand(userCommands, "offline", "Noninteractive disabled", "Hidden.", [
        "disable-noninteractive: true",
      ]);
      // 同名自定义命令不得顶替内置 `/workflow`（保留名）：目录里只剩内置那一行。
      await writeCommand(userCommands, "workflow", "Shadowing workflow", "Should be hidden.");

      const commands = await listProtocolSlashCommands({
        env: { NIBI_ENV: "test" },
        homeDirectory: home,
        skipUserConfig: true,
        workingDirectory: workspace,
      });

      expect(commands.map((command) => ({ name: command.name, source: command.source }))).toEqual([
        { name: "goal", source: "builtin" },
        // `/workflow` 是随 CLI 编译的内置 prompt 命令（builtin-workflow-command.ts）。App `/` 面板
        // 按本目录顺序展示，产品要求工作流紧随目标之后（docs/ui/chat-composer-action-menu.md
        // 「工作流入口」），顺序由 APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES 决定。
        { name: "workflow", source: "builtin" },
        { name: "compact", source: "builtin" },
        { name: "init", source: "builtin" },
        { name: "review", source: "custom" },
        { name: "ship", source: "custom" },
      ]);
      expect(commands.find((command) => command.name === "review")?.description).toBe(
        "User review",
      );
      expect(commands.find((command) => command.name === "ship")?.inputHint).toBe("/ship [target]");
      expect(commands.find((command) => command.name === "workflow")?.inputHint).toBe(
        "/workflow [what the workflow should accomplish]",
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("expands prompt custom commands without taking over reserved builtins", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "nibi-custom-command-prompt-"));
    const workspace = join(tempRoot, "workspace");
    const home = join(tempRoot, "home");
    const userCommands = join(home, ".nibi", "commands");

    try {
      await mkdir(workspace, { recursive: true });
      await mkdir(userCommands, { recursive: true });
      await writeCommand(userCommands, "review", "Review changes", "Review $ARGUMENTS.");
      await writeCommand(userCommands, "init", "Custom init", "Should not expand.");
      await writeCommand(userCommands, "model", "Reserved model", "Should not expand.");
      await writeCommand(userCommands, "plan", "Reserved Plan action", "Should not expand.");

      const options = {
        env: { NIBI_ENV: "test" },
        homeDirectory: home,
        skipUserConfig: true,
        workingDirectory: workspace,
      };
      const prompt = await resolveNibiCustomCommandPrompt("/review src packages", options);

      expect(prompt).toContain("Run custom command /review.");
      expect(prompt).toContain("Command source: user/nibi.");
      expect(prompt).toContain("Review src packages.");
      await expect(resolveNibiCustomCommandPrompt("/model glm-5", options)).resolves.toBe(
        undefined,
      );
      await expect(resolveNibiCustomCommandPrompt("/plan task", options)).resolves.toBe(undefined);
      expect(resolveNibiBuiltinPromptCommand("/plan task", { workingDirectory: workspace })).toBe(
        undefined,
      );
      await expect(resolveNibiCustomCommandPrompt("/init", options)).resolves.toBe(undefined);
      await expect(resolveNibiCustomCommandPrompt("please /review", options)).resolves.toBe(
        undefined,
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  // DWG-03：灰度关闭时 `/workflow` 不得展开。目录侧已经剃掉了它，但用户仍可手打命令名，
  // 两条路径必须给出同一个结论；同时 `workflow` 是保留名，自定义命令解析对它一律不展开，
  // 用户或插件的同名命令既顶替不了内置语义，也绕不过灰度门。
  it("expands builtin /workflow through the builtin resolver only, gated by the feature flag", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "nibi-builtin-workflow-"));
    const workspace = join(tempRoot, "workspace");
    const home = join(tempRoot, "home");
    const userCommands = join(home, ".nibi", "commands");
    try {
      await mkdir(workspace, { recursive: true });
      await mkdir(userCommands, { recursive: true });
      await writeCommand(userCommands, "workflow", "Shadowing workflow", "Should not expand.");
      const options = {
        env: { NIBI_ENV: "test" },
        homeDirectory: home,
        skipUserConfig: true,
        workingDirectory: workspace,
      };

      const expanded = resolveNibiBuiltinPromptCommand("/workflow ship it", {
        dynamicWorkflowEnabled: true,
        workingDirectory: workspace,
      });
      expect(expanded).toContain("Required skills: `dynamic-workflows`.");
      expect(expanded).toContain("ship it");
      expect(expanded).not.toContain("Should not expand.");
      // 缺席（TUI / headless）等于开启；显式 false 才挡下。
      expect(
        resolveNibiBuiltinPromptCommand("/workflow ship it", { workingDirectory: workspace }),
      ).toContain("ship it");
      expect(
        resolveNibiBuiltinPromptCommand("/workflow ship it", {
          dynamicWorkflowEnabled: false,
          workingDirectory: workspace,
        }),
      ).toBe(undefined);
      await expect(resolveNibiCustomCommandPrompt("/workflow ship it", options)).resolves.toBe(
        undefined,
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("expands builtin /init into the workspace AGENTS.md prompt", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "nibi-builtin-init-"));
    const workspace = join(tempRoot, "workspace");

    try {
      await mkdir(workspace, { recursive: true });
      const prompt = resolveNibiBuiltinPromptCommand("/init include pnpm scripts", {
        workingDirectory: workspace,
      });

      expect(prompt).toContain("built-in /init command");
      expect(prompt).toContain("AGENTS.md");
      expect(prompt).toContain(join(workspace, "AGENTS.md"));
      expect(prompt).toContain(join(workspace, ".nibi", "AGENTS.md"));
      expect(prompt).toContain(join(workspace, ".agents", "AGENTS.md"));
      expect(prompt).toContain("they already have an instructions file");
      expect(prompt).not.toContain("Do not create CLAUDE.md or AGNENTS.md");
      expect(prompt).toContain("include pnpm scripts");
      expect(resolveNibiBuiltinPromptCommand("/review", { workingDirectory: workspace })).toBe(
        undefined,
      );
      expect(
        resolveNibiBuiltinPromptCommand("please /init", { workingDirectory: workspace }),
      ).toBe(undefined);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("hands plugin command shell blocks to the model without running them", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "nibi-plugin-command-shell-"));
    const workspace = join(tempRoot, "workspace");
    const pluginRoot = join(tempRoot, "ralph-loop");
    const commandsRoot = join(pluginRoot, "commands");
    const pluginDataRoot = join(tempRoot, "plugins");
    const configPath = join(tempRoot, "config.json");

    try {
      await mkdir(commandsRoot, { recursive: true });
      await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });
      await writeFile(
        join(pluginRoot, ".claude-plugin", "plugin.json"),
        JSON.stringify({ name: "ralph-loop", version: "1.0.0" }),
      );
      await writeCommand(
        commandsRoot,
        "ralph-loop",
        "Start Ralph",
        [
          "Before",
          "```!",
          'echo "${CLAUDE_PLUGIN_ROOT}/scripts/setup-ralph-loop.sh" "$ARGUMENTS"',
          "```",
          "After",
        ].join("\n"),
      );
      await writeFile(
        configPath,
        JSON.stringify({
          plugins: {
            dirs: [pluginRoot],
            enabled: true,
          },
          storage: {
            dir: pluginDataRoot,
          },
        }),
      );

      const prompt = await resolveNibiCustomCommandPrompt("/ralph-loop build demo", {
        env: { NIBI_ENV: "test" },
        projectConfigPath: configPath,
        skipUserConfig: true,
        workingDirectory: workspace,
      });

      // 解析期只改写文本：插件变量换成插件真实路径，$ARGUMENTS 在改写之后展开，命令交给模型执行。
      expect(prompt).toContain(
        "[This shell step comes from the /ralph-loop command file (user/plugin), not from NIBI.",
      );
      expect(prompt).toContain(
        `\`\`\`bash\necho "${pluginRoot.replaceAll("\\", "/")}/scripts/setup-ralph-loop.sh" "build demo"\n\`\`\``,
      );
      expect(prompt).not.toContain("```!");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("holds back shell blocks whose variables only a skill or bash environment can provide", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "nibi-command-shell-missing-context-"));
    const workspace = join(tempRoot, "workspace");
    const home = join(tempRoot, "home");
    const userCommands = join(home, ".nibi", "commands");

    try {
      await mkdir(userCommands, { recursive: true });
      await writeCommand(
        userCommands,
        "skill-context",
        "Needs skill context",
        ["```!", 'echo "${NIBI_SKILL_DIR}"', "```"].join("\n"),
      );
      await writeCommand(
        userCommands,
        "session-context",
        "Needs session context",
        ["```!", 'echo "${NIBI_SESSION_ID}"', "```"].join("\n"),
      );

      const options = {
        env: { NIBI_ENV: "test" },
        homeDirectory: home,
        skipUserConfig: true,
        workingDirectory: workspace,
      };

      // 命令文件没有 skill 目录，整块不转交，只留说明。
      await expect(resolveNibiCustomCommandPrompt("/skill-context", options)).resolves.toContain(
        "[A shell step from the /skill-context command file (user/nibi) was not run: it uses ${NIBI_SKILL_DIR}, which cannot be resolved here.]",
      );
      // 会话变量由 Bash 工具注入，保持原样交给模型。
      await expect(resolveNibiCustomCommandPrompt("/session-context", options)).resolves.toContain(
        '```bash\necho "${NIBI_SESSION_ID}"\n```',
      );
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

async function writeCommand(
  directory: string,
  name: string,
  description: string,
  body: string,
  extraFrontmatter: string[] = [],
): Promise<void> {
  await writeFile(
    join(directory, `${name}.md`),
    ["---", `description: ${description}`, ...extraFrontmatter, "---", "", body].join("\n"),
  );
}
