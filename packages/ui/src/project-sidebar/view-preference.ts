import type { ProjectSidebarView } from "@/project-sidebar/contract.js";
import { getSafeLocalStorage } from "@/lib/browserEnvironment.js";

const PROJECT_SIDEBAR_VIEWS: ReadonlySet<string> = new Set<ProjectSidebarView>([
  "projects",
  "grouped",
  "timeline",
  "unread",
]);

/** 首读和跨窗口同步共用同一白名单，避免两个入口对非法 view 的判断漂移。 */
export function isProjectSidebarView(value: unknown): value is ProjectSidebarView {
  return typeof value === "string" && PROJECT_SIDEBAR_VIEWS.has(value);
}

export function readProjectSidebarView(
  storage: Pick<Storage, "getItem"> | null = getSafeLocalStorage(),
): ProjectSidebarView {
  const read = (key: string): Record<string, unknown> => {
    try {
      return JSON.parse(storage?.getItem(key) ?? "null") ?? {};
    } catch {
      return {};
    }
  };
  const current = read("nibi-project-sidebar-preferences").view;
  if (isProjectSidebarView(current)) return current;
  // 原因：重构换了偏好 key；忽略旧 organizeBy 会让原本选分组的用户升级后跳回项目。
  // 只在没有有效新选择时迁移，不能在以后重启时覆盖用户的新选择。
  const legacy = read("nibi-sidebar-task-preferences").organizeBy;
  return legacy === "grouped" ? "grouped" : legacy === "chronological" ? "timeline" : "projects";
}
