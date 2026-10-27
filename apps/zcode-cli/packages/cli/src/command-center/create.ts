import type { TuiSubmitPrompt } from "@nibi/tui";
import { getZCodeCopy } from "@nibi/i18n";
import {
  formatAvailableCommandNames,
  listCustomCommandsForHelp,
} from "../command-center-custom.js";
import { formatNewSessionResult, formatResumeResult } from "./formatters.js";
import { formatLoginResult, formatLogoutResult, isLoginCancellation } from "./login-flow.js";
import { handleCustomCommand } from "./handlers/custom.js";
import { handleDwfCommand } from "./handlers/dwf.js";
import { handleEffortCommand } from "./handlers/effort.js";
import { handleExpertCommand } from "./handlers/expert.js";
import { handleLocaleCommand } from "./handlers/locale.js";
import { handleMcpCommand } from "./handlers/mcp.js";
import { handleModeCommand } from "./handlers/mode.js";
import { handleModelCommand } from "./handlers/model.js";
import { handlePluginsCommand } from "./handlers/plugins.js";
import { handleSkillListCommand } from "./handlers/skill.js";
import { handleTargetCommand } from "./handlers/goal.js";
import { recordSlashCommandInHistory } from "./history.js";
import { attachCurrentSessionMetadata, normalizeTuiPromptInput } from "./metadata.js";
import { buildCheckpointSelection, buildSessionSelection } from "./selections.js";
import {
  buildManualSkillPrompt,
  formatSlashCommandHelp,
  listAvailableCommandNames,
  parseSlashCommand,
} from "./slash-commands.js";
import { isWorkflowModeEnabled, WORKFLOW_DISABLED_NOTICE } from "../workflow-mode.js";
import { loginRequiredResponse } from "../tui-login-state.js";
import {
  buildCustomProviderStep,
  buildProviderSelection,
  customProviderStep,
  defaultCustomProviderName,
  formatProviderRenameOutcome,
  formatProviderSetupOutcome,
  isCustomProviderId,
  parseProviderArgs,
  parseProviderRenameArgs,
  providerSetupResponse,
} from "./provider-flow.js";
import type { CommandCenterDeps } from "./types.js";

export function createCommandCenter(deps: CommandCenterDeps): TuiSubmitPrompt {
  return async (input, options) => {
    const promptInput = normalizeTuiPromptInput(input);
    const command = parseSlashCommand(promptInput.text);
    const hasAttachments = (promptInput.attachments?.length ?? 0) > 0;

    if (!command) {
      if (await isLoginRequired(deps)) {
        return {
          loginRequired: true,
          mode: deps.getMode?.(),
          response: loginRequiredResponse(deps.getLocale?.()),
        };
      }
      const app = await deps.getApp();
      return attachCurrentSessionMetadata(await app.submitPrompt(input, options), deps, app);
    }

    if (hasAttachments) {
      return {
        mode: deps.getMode?.(),
        response: "Image attachments are only supported for normal prompts.",
      };
    }

    if (command.type === "unknown") {
      const customResult = await handleCustomCommand(command.rawName, command.args, deps, options);
      if (customResult) {
        await recordSlashCommandInHistory(deps, promptInput.text, command);
        return customResult;
      }
      const customCommands = await listCustomCommandsForHelp(deps);
      return {
        mode: deps.getMode?.(),
        response: `Unknown command: /${command.rawName}. Available commands: ${formatAvailableCommandNames(listAvailableCommandNames(deps), customCommands)}.`,
      };
    }

    const result = await (async () => {
      if (command.name === "help") {
        const customCommands = await listCustomCommandsForHelp(deps);
        return {
          mode: deps.getMode?.(),
          response: formatSlashCommandHelp(command.args, customCommands, deps),
        };
      }

      if (command.name === "login") {
        // NIBI 账号登录：本地流程，不创建 App、不发模型请求。
        const copy = getZCodeCopy(deps.getLocale?.()).tui.login;
        if (command.args.trim().length > 0) {
          return { mode: deps.getMode?.(), response: copy.usage };
        }
        if (!deps.login) {
          return { mode: deps.getMode?.(), response: copy.unavailable };
        }
        let deviceMessage: string | null = null;
        try {
          const result = await deps.login({
            abortSignal: options.abortSignal,
            onBrowserOpen: (browser) => {
              if (!browser.opened) {
                deviceMessage = `Browser open failed: ${browser.reason ?? "unknown error"}`;
              }
            },
            onDeviceCode: (data) => {
              deviceMessage = copy.deviceCode(
                data.verificationUriComplete ?? data.verificationUri,
                data.userCode,
              );
            },
          });
          return {
            loginRequired: false,
            mode: deps.getMode?.(),
            response: [deviceMessage, formatLoginResult(deps.getLocale?.(), result)]
              .filter((line): line is string => Boolean(line))
              .join("\n\n"),
          };
        } catch (error) {
          if (isLoginCancellation(error)) {
            return { mode: deps.getMode?.(), response: copy.cancelled };
          }
          throw error;
        }
      }

      if (command.name === "logout") {
        const copy = getZCodeCopy(deps.getLocale?.()).tui.login;
        if (command.args.trim().length > 0) {
          return { mode: deps.getMode?.(), response: copy.logoutUsage };
        }
        if (!deps.logout) {
          return { mode: deps.getMode?.(), response: copy.unavailable };
        }
        await deps.logout();
        return { loginRequired: false, mode: deps.getMode?.(), response: formatLogoutResult(deps.getLocale?.()) };
      }

      if (command.name === "provider") {
        if (command.args.length === 0) {
          if (!deps.listProviderTemplates) {
            return {
              mode: deps.getMode?.(),
              response: "Provider setup is not available in this client.",
            };
          }
          const templates = await deps.listProviderTemplates();
          return {
            loginRequired: await isLoginRequired(deps),
            mode: deps.getMode?.(),
            response: providerSetupResponse(deps.getLocale?.()),
            ...(templates.length === 0
              ? {}
              : { selection: buildProviderSelection(deps.getLocale?.(), templates) }),
          };
        }

        const head = command.args.trim().split(/\s+/u)[0] ?? "";
        if (isCustomProviderId(head)) {
          const state = customProviderStep(command.args.trim().split(/\s+/u).slice(1));
          if (state.step < 6) {
            const next = buildCustomProviderStep(deps.getLocale?.(), head, state);
            return {
              loginRequired: await isLoginRequired(deps),
              mode: deps.getMode?.(),
              response: next.response,
              selection: next.selection,
            };
          }
          if (!deps.setupCustomProvider) {
            return {
              mode: deps.getMode?.(),
              response: "Custom provider setup is not available in this client.",
            };
          }
          const custom = await deps.setupCustomProvider({
            apiKey: state.apiKey!,
            // 兜底：上面已按 step 收敛，这里不会是 undefined
            apiType: head === "custom-anthropic" ? "anthropic-messages" : "openai-chat-completions",
            baseUrl: state.baseUrl!,
            contextWindow: state.contextWindow!,
            maxOutputTokens: state.maxOutputTokens!,
            modelId: state.modelId!,
            modalities: state.modalities ?? [],
            // 显示名不单独问：按 API 主机名自动推，想改走 /provider rename。
            providerName: defaultCustomProviderName(state.baseUrl),
            reasoningLevels: state.reasoningLevels ?? [],
          });
          return {
            loginRequired: false,
            mode: deps.getMode?.(),
            response: formatProviderSetupOutcome(custom),
          };
        }

        if (head === "rename") {
          const rename = parseProviderRenameArgs(command.args.trim());
          if (!rename) {
            return {
              mode: deps.getMode?.(),
              response:
                "Usage: /provider rename <providerId> <new name>\n" +
                "Use /model to see each provider's id; renaming never changes the id.",
            };
          }
          if (!deps.renameProvider) {
            return {
              mode: deps.getMode?.(),
              response: "Provider rename is not available in this client.",
            };
          }
          try {
            const renamed = await deps.renameProvider(rename);
            return {
              loginRequired: false,
              mode: deps.getMode?.(),
              response: formatProviderRenameOutcome(renamed),
            };
          } catch (error) {
            // 重名是预期内的用户错误（服务端 assertProviderLabelMutationIsUnique 会拒），
            // 直接回执而不是把异常抛给上层的通用错误路径。
            return {
              mode: deps.getMode?.(),
              response: `Rename failed: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }

        const parsed = parseProviderArgs(command.args);
        if (!parsed) {
          return {
            loginRequired: await isLoginRequired(deps),
            mode: deps.getMode?.(),
            response: `Usage: /provider ${command.args.trim()} <api-key>`,
          };
        }        if (!deps.setupProvider) {
          return {
            mode: deps.getMode?.(),
            response: "Provider setup is not available in this client.",
          };
        }

        const result = await deps.setupProvider(parsed);
        return {
          loginRequired: false,
          mode: deps.getMode?.(),
          response: formatProviderSetupOutcome(result),
        };
      }

      if (command.name === "compact") {
        const app = await deps.getApp();
        const prompt = command.args ? `/compact ${command.args}` : "/compact";
        return attachCurrentSessionMetadata(await app.submitPrompt(prompt, options), deps, app);
      }

      if (command.name === "init") {
        const app = await deps.getApp();
        const prompt = command.args ? `/init ${command.args}` : "/init";
        // TUI 已知 slash command 若没有显式分支，会落到文件末尾的
        // resume 兜底。/init 是普通 prompt command，必须交给 app.submitPrompt
        // 进入 bootstrap resolver，才能和 app --stdio 复用同一套展开逻辑。
        return attachCurrentSessionMetadata(await app.submitPrompt(prompt, options), deps, app);
      }

      if (command.name === "workflow") {
        // disabled 下 builtin resolver 不展开 `/workflow`，照常提交会把原文当普通文本发给模型；
        // 在本地拦下，不建 app、不发模型（launch.md「The standalone CLI: `--workflow-mode`」）。
        if (!isWorkflowModeEnabled(deps.workflowMode)) {
          return { mode: deps.getMode?.(), response: WORKFLOW_DISABLED_NOTICE };
        }
        const app = await deps.getApp();
        const prompt = command.args ? `/workflow ${command.args}` : "/workflow";
        // 与 /init 同款：原文交给 app.submitPrompt，由 bootstrap 的 builtin resolver 展开成
        // 「先加载 dynamic-workflows 技能，再写脚本调 CreateWorkflow」的提示词。
        return attachCurrentSessionMetadata(await app.submitPrompt(prompt, options), deps, app);
      }

      if (command.name === "expert") {
        return handleExpertCommand(command.args, deps, options);
      }

      if (command.name === "effort") {
        return handleEffortCommand(command.args, deps);
      }

      if (command.name === "dwf") {
        return handleDwfCommand(command.args, deps);
      }

      if (command.name === "rewind") {
        const app = await deps.getApp();
        if (command.args.length === 0 && app.listCheckpoints) {
          return {
            mode: deps.getMode?.(),
            response: "Select a checkpoint to rewind.",
            selection: buildCheckpointSelection("rewind", await app.listCheckpoints({ limit: 50 })),
          };
        }
        const prompt = command.args ? `/rewind ${command.args}` : "/rewind";
        return attachCurrentSessionMetadata(await app.submitPrompt(prompt, options), deps, app);
      }

      if (command.name === "fork") {
        if (command.args.length === 0) {
          const app = await deps.getApp();
          if (app.listCheckpoints) {
            return {
              mode: deps.getMode?.(),
              response: "Select a checkpoint to fork.",
              selection: buildCheckpointSelection("fork", await app.listCheckpoints({ limit: 50 })),
            };
          }
        }
        const targetCheckpointId = parseForkTarget(command.args);
        if (deps.forkApp) {
          const result = await deps.forkApp(targetCheckpointId);
          return {
            mode: deps.getMode?.(),
            response: result.response,
            traceId: undefined,
          };
        }

        const app = await deps.getApp();
        const prompt = targetCheckpointId ? `/fork ${targetCheckpointId}` : "/fork latest";
        return attachCurrentSessionMetadata(await app.submitPrompt(prompt, options), deps, app);
      }

      if (command.name === "mode") {
        return handleModeCommand(command.args, deps);
      }

      if (command.name === "locale") {
        return handleLocaleCommand(command.args, deps);
      }

      if (command.name === "mcp") {
        return handleMcpCommand(command.args, deps);
      }

      if (command.name === "plugins") {
        return handlePluginsCommand(command.args, deps);
      }

      if (command.name === "model") {
        return handleModelCommand(command.args, deps, promptInput.modelSelection);
      }

      if (command.name === "goal") {
        return handleTargetCommand(command.args, deps, options);
      }

      if (command.name === "new") {
        if (command.args.length > 0) {
          return {
            mode: deps.getMode?.(),
            response: "Usage: /new",
          };
        }
        if (!deps.newApp) {
          return {
            mode: deps.getMode?.(),
            response: "Creating a new session is not available in this client.",
          };
        }

        const app = await deps.newApp();
        return {
          mode: deps.getMode?.(),
          locale: app.getLocale?.(),
          model: app.getModel?.(),
          theme: app.getTheme?.(),
          resetSessionProjection: true,
          response: formatNewSessionResult(app.sessionId),
          sessionId: app.sessionId,
          thoughtLevel: app.getThoughtLevel?.(),
          traceId: app.traceId,
        };
      }

      if (command.name === "skill") {
        if (!command.skillName) {
          return handleSkillListCommand(deps);
        }
        const app = await deps.getApp();
        return attachCurrentSessionMetadata(
          await app.submitPrompt(buildManualSkillPrompt(command.skillName, command.task), options),
          deps,
          app,
        );
      }

      if (
        command.name === "resume" &&
        command.args.length === 0 &&
        command.rawName === "resume" &&
        deps.listSessions
      ) {
        return {
          mode: deps.getMode?.(),
          response: "Select a session to resume.",
          selection: buildSessionSelection(await deps.listSessions()),
        };
      }

      const app = await deps.resumeApp(command.args || undefined);
      const result = await app.resume({
        onEvent: options.onEvent,
      });
      const restoredMessages = app.loadSessionTranscript
        ? await app.loadSessionTranscript()
        : undefined;

      return {
        mode: deps.getMode?.(),
        locale: app.getLocale?.(),
        model: app.getModel?.(),
        theme: app.getTheme?.(),
        ...(restoredMessages !== undefined
          ? {
              resetSessionProjection: true,
              restoredMessages,
            }
          : {}),
        response: formatResumeResult(app.sessionId, result),
        thoughtLevel: app.getThoughtLevel?.(),
        traceId: result.traceId ?? app.traceId,
      };
    })();

    // 账号命令不进输入历史：既没有可回放的价值，也可能把旧习惯里的 `/login <secret>` 留在历史里。
    if (command.name !== "login" && command.name !== "logout") {
      await recordSlashCommandInHistory(deps, promptInput.text, command);
    }
    return result;
  };
}

function parseForkTarget(args: string): string | undefined {
  const trimmed = args.trim();
  if (trimmed.length === 0 || trimmed === "latest") return undefined;
  return trimmed;
}

async function isLoginRequired(deps: CommandCenterDeps): Promise<boolean> {
  if (!deps.hasSelectableModels) return false;
  try {
    return !(await deps.hasSelectableModels());
  } catch {
    return false;
  }
}
