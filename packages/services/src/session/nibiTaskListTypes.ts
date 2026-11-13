import type { WorkspacePurpose, NibiTaskMeta } from "@nibi/shared";

export type NibiTaskListKind = "pinned" | "archived" | "timeline" | "active";
export type NibiTaskListSortBy = "created" | "updated";

export interface NibiTaskListWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
  workspacePurpose?: WorkspacePurpose;
}

export interface NibiTaskListQuery {
  kind: NibiTaskListKind;
  workspaceScopes: NibiTaskListWorkspaceScope[];
  sortBy: NibiTaskListSortBy;
  search?: string;
  limit?: number;
}

export type NibiTaskListItem = NibiTaskMeta & {
  searchSnippet?: string;
  searchSnippets?: string[];
};

export interface NibiTaskListResult {
  items: NibiTaskListItem[];
  total: number;
  hasMore: boolean;
}

export interface NibiWorkspaceEventSubscriptionParams {
  workspacePath: string;
  workspaceIdentity?: string;
}
