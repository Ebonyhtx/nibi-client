import { join, posix, resolve } from "node:path";

import type { FileSystemPort, Logger, TraceContext } from "@nibi/contracts";

import { ensureMemoryDirectoryExists } from "../memory/directory.js";
import type { MemoryRuntimeConfig } from "../runtime/types.js";
import type { AgentDefinitionsSnapshot } from "./definitions.js";
import type { AgentProfile, AgentMemoryScope } from "./profile.js";
import { buildPersistentAgentMemoryPrompt } from "./persistent-memory-prompt.js";

const PERSISTENT_MEMORY_TOOLS = ["Write", "Edit"] as const;

/**
 * 记忆根可能不是宿主原生形状（WSL / 远程工作区 / 测试里的 /storage）：POSIX 形状的根
 * 一律按 POSIX 语义拼路径。win32 的 join 会产出 \storage\agent-memory\...，
 * 与「根是 /storage/agent-memory/...」的约定不一致，整组记忆用例会在 Windows 上失败。
 */
function isPosixRoot(root: string): boolean {
  return root.startsWith("/") && !/^[A-Za-z]:/u.test(root) && !root.includes("\\");
}

function joinRoot(root: string, ...segments: string[]): string {
  return isPosixRoot(root) ? posix.join(root, ...segments) : join(root, ...segments);
}

export function sanitizePersistentAgentMemoryKey(agentName: string): string {
  const key = agentName.replace(/[^a-zA-Z0-9_-]/g, "-");
  return key === "" ? "unknown" : key;
}

export function resolvePersistentAgentMemoryRoot(input: {
  agentName: string;
  scope: AgentMemoryScope;
  storageRoot: string;
  workspaceRoot: string;
}): string {
  const agentKey = sanitizePersistentAgentMemoryKey(input.agentName);
  if (input.scope === "user") {
    return joinRoot(input.storageRoot, "agent-memory", agentKey);
  }
  const workspace = isPosixRoot(input.workspaceRoot)
    ? posix.normalize(input.workspaceRoot)
    : resolve(input.workspaceRoot);
  return input.scope === "project"
    ? joinRoot(workspace, ".nibi", "agent-memory", agentKey)
    : joinRoot(workspace, ".nibi", "agent-memory-local", agentKey);
}

function isPersistentAgentMemoryEnabled(
  memory: MemoryRuntimeConfig | undefined,
): memory is MemoryRuntimeConfig & { storageRoot: string } {
  return memory?.enabled === true && memory.use !== false && Boolean(memory.storageRoot);
}

function withPersistentAgentMemoryTools(profile: AgentProfile): AgentProfile {
  if (!profile.memory || profile.tools === undefined) return profile;

  const tools = [...profile.tools];
  for (const tool of PERSISTENT_MEMORY_TOOLS) {
    if (!tools.includes(tool)) tools.push(tool);
  }
  return tools.length === profile.tools.length ? profile : { ...profile, tools };
}

export function projectPersistentAgentMemoryTools(
  definitions: AgentDefinitionsSnapshot,
  memory: MemoryRuntimeConfig | undefined,
): AgentDefinitionsSnapshot {
  if (!isPersistentAgentMemoryEnabled(memory)) return definitions;
  const profiles = definitions.activeAgents;

  const projected = profiles.map(withPersistentAgentMemoryTools);
  if (projected.every((profile, index) => profile === profiles[index])) return definitions;
  return {
    ...definitions,
    activeAgents: projected,
  };
}

export interface PersistentAgentMemory {
  rootDir: string;
  prompt: string;
}

export async function loadPersistentAgentMemory(input: {
  fileSystemPort: FileSystemPort | undefined;
  memory: MemoryRuntimeConfig | undefined;
  logger?: Logger;
  profile: AgentProfile;
  traceContext?: TraceContext;
  workspaceRoot: string;
}): Promise<PersistentAgentMemory | undefined> {
  if (!input.profile.memory || !input.fileSystemPort) return undefined;
  if (!isPersistentAgentMemoryEnabled(input.memory)) return undefined;

  const rootDir = resolvePersistentAgentMemoryRoot({
    agentName: input.profile.name,
    scope: input.profile.memory,
    storageRoot: input.memory.storageRoot,
    workspaceRoot: input.workspaceRoot,
  });
  await ensureMemoryDirectoryExists(
    input.fileSystemPort,
    rootDir,
    input.traceContext,
    input.logger,
  );

  let indexContent = "";
  try {
    indexContent = (await input.fileSystemPort.readTextFile({ path: join(rootDir, "MEMORY.md") }))
      .content;
  } catch {
    // 不存在或不可读的 MEMORY.md 都使用基线的 empty index 文案。
  }

  return {
    rootDir,
    prompt: buildPersistentAgentMemoryPrompt({
      indexContent,
      rootDir,
      scope: input.profile.memory,
    }),
  };
}
