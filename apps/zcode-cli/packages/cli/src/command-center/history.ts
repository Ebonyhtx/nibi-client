import type { TuiPromptInput } from "@nibi/tui";
import type { SlashCommand } from "./slash-command-types.js";
import type { CommandCenterDeps } from "./types.js";

// 只匹配 /provider：它的每条调用都可能带 API Key（模板路径在第 2 个参数，
// 自定义路径在末位），一律不写进输入历史文件。

export async function recordSlashCommandInHistory(
  deps: CommandCenterDeps,
  input: TuiPromptInput,
  command: SlashCommand,
): Promise<void> {
  if (!deps.recordInputHistory || !shouldRecordSlashCommand(command)) return;
  try {
    await deps.recordInputHistory(input, "slash_command");
  } catch {
    // Input history is recall UX; command execution must not depend on it.
  }
}

function shouldRecordSlashCommand(command: SlashCommand): boolean {
  if (command.type !== "known") return true;
  return command.name !== "provider";
}
