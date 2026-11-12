import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * 会话候选按 workspace 分组后的勾选状态。
 * 首启（Onboarding）与设置页迁移向导共用，避免两套“首次扫描默认全选、重扫后剔除失效项”的逻辑漂移。
 */
export function useWorkspaceSessionSelection(
  candidates: ReadonlyArray<{ workspacePath: string }>,
) {
  const [selectedWorkspacePaths, setSelectedWorkspacePaths] = useState<string[]>([]);
  const initializedWorkspaceSelectionRef = useRef(false);

  const availableWorkspacePaths = useMemo(
    () => [...new Set(candidates.map((candidate) => candidate.workspacePath))],
    [candidates],
  );

  useEffect(() => {
    if (availableWorkspacePaths.length === 0) {
      initializedWorkspaceSelectionRef.current = false;
      setSelectedWorkspacePaths([]);
      return;
    }

    if (!initializedWorkspaceSelectionRef.current) {
      initializedWorkspaceSelectionRef.current = true;
      setSelectedWorkspacePaths(availableWorkspacePaths);
      return;
    }

    setSelectedWorkspacePaths((previous) =>
      previous.filter((workspacePath) => availableWorkspacePaths.includes(workspacePath)),
    );
  }, [availableWorkspacePaths]);

  const toggleWorkspace = useCallback((workspacePath: string) => {
    setSelectedWorkspacePaths((previous) =>
      previous.includes(workspacePath)
        ? previous.filter((current) => current !== workspacePath)
        : [...previous, workspacePath],
    );
  }, []);

  const selectAllWorkspaces = useCallback(() => {
    setSelectedWorkspacePaths(availableWorkspacePaths);
  }, [availableWorkspacePaths]);

  const clearWorkspaceSelection = useCallback(() => {
    setSelectedWorkspacePaths([]);
  }, []);

  /** 关闭/重开向导时恢复“下一次扫描默认全选”的初始状态。 */
  const resetWorkspaceSelection = useCallback(() => {
    initializedWorkspaceSelectionRef.current = false;
    setSelectedWorkspacePaths([]);
  }, []);

  return {
    selectedWorkspacePaths,
    selectedWorkspaceCount: selectedWorkspacePaths.length,
    availableWorkspacePaths,
    toggleWorkspace,
    selectAllWorkspaces,
    clearWorkspaceSelection,
    resetWorkspaceSelection,
  };
}
