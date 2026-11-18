// 项目发现：本机项目来自 IProjectService，远端来源来自 IRemoteProjectService。
// 只把真实可搜索的来源放进 searchScope；离线、旧版或读取失败的来源进 unavailableSources，
// 绝不用缓存伪造一个「已搜索」的结论。
import type { IProjectService } from "../project/contract.js";
import type { IRemoteProjectService } from "../remote-projects/contract.js";
import type { IWindowControllerService } from "../window-controller/windowController.js";
import type {
  AppControlListProjectsResult,
  AppControlProjectEntry,
  AppControlSearchScope,
  AppControlScope,
  AppControlUnavailableSource,
} from "./contract.js";
import { hostScope } from "./context.js";

/** 一个能在 tasks-index 里定位的会话；sourceServerId 只在远端来源时存在。 */
export interface ResolvedAppSession {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  projectId?: string;
  sourceServerId?: string;
}

export interface AppControlDiscoveryDirectory {
  listProjects(query?: string): Promise<AppControlListProjectsResult>;
  listScopes(): Promise<AppControlSearchScope>;
  resolveSession(sessionId: string): Promise<ResolvedAppSession | undefined>;
}

export interface AppControlDiscoveryDependencies {
  projectService?: Pick<IProjectService, "readTree" | "readProjects">;
  remoteProjectService?: Pick<IRemoteProjectService, "readDirectory">;
  resolveWindowControllerService?: () =>
    | Pick<IWindowControllerService, "getTaskMeta">
    | undefined;
  logWarn?: (message: string, error?: unknown) => void;
}

interface SourceSnapshot {
  scopes: AppControlScope[];
  unavailableSources: AppControlUnavailableSource[];
  projects: AppControlProjectEntry[];
  /** 本地任务索引里的会话 → 完整地址（远端来源不在这里）。 */
  localTasks: Map<string, ResolvedAppSession>;
  /** 在线远端来源（projectId → 来源）；用于解析远端会话。 */
  remoteProjects: Map<
    string,
    { sourceServerId: string; projectId: string; roots: string[] }
  >;
}

function normalizeQuery(value: string | undefined): string | undefined {
  const query = value?.trim().toLowerCase();
  return query ? query : undefined;
}

function matchesQuery(query: string | undefined, ...values: Array<string | undefined>): boolean {
  if (!query) return true;
  return values.some((value) => value?.toLowerCase().includes(query));
}

function remoteKey(sourceServerId: string | undefined, projectId: string): string {
  return `${sourceServerId ?? ""}\0${projectId}`;
}

function sourceReason(host: {
  connectionStatus?: "online" | "connecting" | "offline";
  lastConnectionError?: string;
}): string {
  switch (host.connectionStatus) {
    case "offline":
      return "offline";
    case "connecting":
      return "connecting";
    case undefined:
      return "source status unknown";
    default:
      return host.lastConnectionError?.trim() || "unavailable";
  }
}

export function createAppControlDiscoveryDirectory(
  deps: AppControlDiscoveryDependencies,
): AppControlDiscoveryDirectory {
  const logWarn = deps.logWarn ?? (() => {});

  async function readLocal(snapshot: SourceSnapshot): Promise<void> {
    const service = deps.projectService;
    if (!service) {
      snapshot.unavailableSources.push({
        sourceServerId: "local",
        reason: "Project service is unavailable",
      });
      return;
    }
    try {
      const tree = await service.readTree({ includeDeleted: false });
      const projects = tree.projects.filter((project) => !project.deleted);
      for (const project of projects) {
        snapshot.projects.push({
          project: { kind: "app", projectId: project.id },
          title: project.name,
        });
      }
      snapshot.scopes.push(hostScope());
      for (const task of tree.tasks) {
        snapshot.localTasks.set(task.taskId, {
          sessionId: task.taskId,
          workspacePath: task.workspacePath,
          ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
          ...(task.projectId ? { projectId: task.projectId } : {}),
        });
      }
    } catch (error) {
      logWarn("app-control: reading local projects failed", error);
      snapshot.unavailableSources.push({
        sourceServerId: "local",
        reason: "Project service read failed",
      });
    }
  }

  async function readRemote(snapshot: SourceSnapshot): Promise<void> {
    const service = deps.remoteProjectService;
    if (!service) return;
    let directory;
    try {
      directory = await service.readDirectory();
    } catch (error) {
      logWarn("app-control: reading remote project directory failed", error);
      snapshot.unavailableSources.push({
        sourceServerId: "remote",
        reason: "Remote project directory is unavailable",
      });
      return;
    }
    for (const host of directory.hosts) {
      const entries = directory.entries.filter((entry) => entry.hostId === host.id);
      if (host.connectionStatus !== "online") {
        snapshot.unavailableSources.push({
          sourceServerId: host.id,
          reason: sourceReason(host),
        });
        continue;
      }
      // 在线来源里没有项目 id 的入口是旧版单 root 工作区：能看见，但不能给出可回放的
      // App project 引用，因此按来源记一条不可用原因，不用 null/空 id 伪造项目行。
      const usable = entries.filter(
        (entry): entry is typeof entry & { projectId: string } =>
          typeof entry.projectId === "string" && entry.projectId.trim().length > 0,
      );
      if (usable.length === 0 && entries.some((entry) => entry.legacyWorkspace !== null)) {
        snapshot.unavailableSources.push({
          sourceServerId: host.id,
          reason: "legacy project without a stable project id",
        });
        continue;
      }
      snapshot.scopes.push(hostScope(host.id));
      for (const entry of usable) {
        snapshot.projects.push({
          project: {
            kind: "app",
            projectId: entry.projectId,
            sourceServerId: host.id,
          },
          title: entry.name,
        });
        const roots = entry.roots.map((root) => root.rootPath).filter(Boolean);
        if (roots.length > 0) {
          snapshot.remoteProjects.set(remoteKey(host.id, entry.projectId), {
            sourceServerId: host.id,
            projectId: entry.projectId,
            roots,
          });
        }
      }
    }
  }

  async function snapshot(): Promise<SourceSnapshot> {
    const state: SourceSnapshot = {
      scopes: [],
      unavailableSources: [],
      projects: [],
      localTasks: new Map(),
      remoteProjects: new Map(),
    };
    await readLocal(state);
    await readRemote(state);
    return state;
  }

  return {
    async listProjects(query) {
      const state = await snapshot();
      const normalized = normalizeQuery(query);
      const seen = new Set<string>();
      const projects = state.projects.filter((entry) => {
        if (!matchesQuery(normalized, entry.title, entry.project.projectId)) return false;
        const key = remoteKey(entry.project.sourceServerId, entry.project.projectId);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return {
        projects,
        searchScope: {
          scopes: state.scopes,
          unavailableSources: state.unavailableSources,
        },
      };
    },

    async listScopes() {
      const state = await snapshot();
      return { scopes: state.scopes, unavailableSources: state.unavailableSources };
    },

    async resolveSession(sessionId) {
      const state = await snapshot();
      const local = state.localTasks.get(sessionId);
      if (local) return local;
      const windowController = deps.resolveWindowControllerService?.();
      if (!windowController) return undefined;
      for (const source of state.remoteProjects.values()) {
        for (const rootPath of source.roots) {
          try {
            const meta = await windowController.getTaskMeta({
              address: {
                taskId: sessionId,
                workspacePath: rootPath,
                sourceServerId: source.sourceServerId,
              },
            });
            if (meta?.taskId === sessionId) {
              return {
                sessionId,
                workspacePath: meta.workspacePath,
                ...(meta.workspaceIdentity ? { workspaceIdentity: meta.workspaceIdentity } : {}),
                projectId: source.projectId,
                sourceServerId: source.sourceServerId,
              };
            }
          } catch (error) {
            logWarn("app-control: resolving a remote session failed", error);
          }
        }
      }
      return undefined;
    },
  };
}