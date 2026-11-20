// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageResponse } from "@/components/ai-elements/message.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { WorkspaceFileTreeRowView } from "@/workspace-file-tree/WorkspaceFileTreeRowView.js";

const state = vi.hoisted(() => ({
  native: true,
  hasSaveFile: true,
  services: null as object | null,
  remote: false,
  remoteTarget: undefined as unknown,
  saveFile: vi.fn(),
  fileService: {
    stat: vi.fn(),
    readFileRange: vi.fn(),
  },
}));

vi.mock("@/hooks/usePlatform.js", () => {
  const platform = () => ({
    canOpenLocalFiles: state.native,
    openExternalFile: vi.fn().mockResolvedValue({ success: true }),
    openInFileManager: vi.fn().mockResolvedValue({ success: true }),
    getInstalledEditors: vi.fn().mockResolvedValue([]),
    openInEditor: vi.fn().mockResolvedValue({ success: true }),
    openExternal: vi.fn(),
    saveFile: state.hasSaveFile ? state.saveFile : undefined,
  });
  return { usePlatform: platform, useOptionalPlatform: platform };
});
vi.mock("@/hooks/useServices.js", () => ({
  useOptionalServices: () => state.services,
  useServices: () => state.services ?? {},
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServices: () => ({ fileService: state.fileService }),
}));
vi.mock("@/hooks/useWorkspaceOpenInEditorTarget.js", () => ({
  useWorkspaceOpenInEditorTarget: () => ({
    isRemoteWorkspace: state.remote,
    remoteTarget: state.remoteTarget,
  }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useNibiIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/store/StoreProvider.js", () => ({
  useNibiStore: (selector: (state: unknown) => unknown) =>
    selector({
      codePreviewSettings: {
        darkTheme: "github-dark",
        fontSizePx: 13,
        lightTheme: "github-light",
        wrapLongLines: true,
      },
      theme: "nibi-light",
    }),
}));

const contextMenuLabels = {
  addToChat: "addToChat",
  copyAbsolutePath: "copyAbsolutePath",
  copyRelativePath: "copyRelativePath",
  open: "open",
  openInBrowser: "openInBrowser",
  openFailed: "openFailed",
  openWith: "openWith",
  reveal: "reveal",
};

const gitStatusLabelByStatus = {
  modified: "modified",
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  untracked: "untracked",
  ignored: "ignored",
};

const fileRow = {
  path: "/workspace/report.txt",
  name: "report.txt",
  type: "file" as const,
  depth: 1,
  expanded: false,
  loaded: true,
  loading: false,
  error: null,
};

function renderRow(
  options: {
    services?: object | null;
    hasSaveFile?: boolean;
    gitStatus?: "modified" | "deleted";
    row?:
      | typeof fileRow
      | {
          path: string;
          name: string;
          type: "file" | "directory";
          depth: number;
          expanded: boolean;
          loaded: boolean;
          loading: boolean;
          error: Error | null;
        };
  } = {},
) {
  state.services = options.services === undefined ? {} : options.services;
  state.hasSaveFile = options.hasSaveFile ?? true;
  const row = options.row ?? fileRow;
  render(
    createElement(
      TooltipProvider,
      null,
      createElement(WorkspaceFileTreeRowView, {
        row,
        selected: false,
        gitStatus: options.gitStatus ?? "modified",
        directoryGitStatuses: [],
        gitStatusLabelByStatus,
        contextMenuLabels,
        canOpenLocalFileManager: true,
        installedEditors: [],
        isRemoteWorkspaceFileTree: false,
        workspacePath: "/workspace",
        style: {},
        onSelect: vi.fn(),
        onToggleDirectory: vi.fn(),
        onOpenPreview: vi.fn(),
        onKeyDown: vi.fn(),
      }),
    ),
  );
  fireEvent.contextMenu(screen.getByRole("treeitem"));
}

function hasIcon(item: HTMLElement | null) {
  return item?.querySelector("svg") !== null;
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  state.native = true;
  state.hasSaveFile = true;
  state.services = {};
  state.remote = false;
  state.remoteTarget = undefined;
  state.saveFile.mockResolvedValue({ success: true });
  state.fileService.stat.mockResolvedValue({ type: "file", size: 3, mtimeMs: 1 });
  state.fileService.readFileRange.mockResolvedValue(new Uint8Array([1, 2, 3]));
});

describe("workspace file tree file actions", () => {
  it("adds save as and icons to the row context menu", async () => {
    renderRow();
    const saveAs = await screen.findByText("fileActions.saveAs");
    expect(hasIcon(saveAs.closest('[role="menuitem"]'))).toBe(true);
    for (const label of ["open", "reveal", "copyAbsolutePath", "copyRelativePath", "addToChat"]) {
      expect(hasIcon(screen.getByText(label).closest('[role="menuitem"]'))).toBe(true);
    }
  });

  it("hides save as when the platform cannot save files", () => {
    renderRow({ hasSaveFile: false });
    expect(screen.queryByText("fileActions.saveAs")).toBeNull();
    expect(screen.getByText("reveal")).toBeTruthy();
  });

  it("hides save as when there is no workspace service", () => {
    renderRow({ services: null });
    expect(screen.queryByText("fileActions.saveAs")).toBeNull();
  });

  it("disables save as for deleted rows and omits it for directories", () => {
    renderRow({ gitStatus: "deleted" });
    const deleted = screen.getByText("fileActions.saveAs").closest('[role="menuitem"]');
    expect(deleted?.getAttribute("data-disabled")).not.toBeNull();
    cleanup();
    renderRow({ row: { ...fileRow, path: "/workspace/src", name: "src", type: "directory" } });
    expect(screen.queryByText("fileActions.saveAs")).toBeNull();
  });

  it("saves the row file through the workspace file service", async () => {
    renderRow();
    fireEvent.click(await screen.findByText("fileActions.saveAs"));
    await waitFor(() => expect(state.saveFile).toHaveBeenCalledTimes(1));
    expect(state.saveFile.mock.calls[0]![0]).toMatchObject({ suggestedName: "report.txt" });
  });
});

describe("message file link file actions", () => {
  function renderMessageLink(options: { services?: object | null; hasSaveFile?: boolean } = {}) {
    state.services =
      options.services === undefined ? { fileService: state.fileService } : options.services;
    state.hasSaveFile = options.hasSaveFile ?? true;
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(
          MessageResponse,
          {
            workspacePath: "/workspace",
            theme: "light",
            onOpenFileLink: vi.fn(),
          },
          "[report.txt](/workspace/report.txt)",
        ),
      ),
    );
  }

  it("adds reveal, save as and the Open row icon to message file links", async () => {
    renderMessageLink();
    const link = screen.getByRole("button", { name: /report\.txt/ });
    fireEvent.contextMenu(link);
    const openItem = screen.getByText("common.open").closest('[role="menuitem"]');
    expect(hasIcon(openItem)).toBe(true);
    expect(screen.getByText("appHeader.openInFileManager")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("fileActions.saveAs")).toBeTruthy());
    expect(hasIcon(screen.getByText("fileActions.saveAs").closest('[role="menuitem"]'))).toBe(true);
  });

  it("hides save as when the platform cannot save files", async () => {
    renderMessageLink({ hasSaveFile: false });
    fireEvent.contextMenu(screen.getByRole("button", { name: /report\.txt/ }));
    expect(screen.getByText("appHeader.openInFileManager")).toBeTruthy();
    await waitFor(() => expect(state.fileService.stat).toHaveBeenCalled());
    expect(screen.queryByText("fileActions.saveAs")).toBeNull();
  });

  it("hides save as when the link has no workspace service", async () => {
    renderMessageLink({ services: null });
    fireEvent.contextMenu(screen.getByRole("button", { name: /report\.txt/ }));
    await waitFor(() => expect(state.fileService.stat).not.toHaveBeenCalled());
    expect(screen.queryByText("fileActions.saveAs")).toBeNull();
  });
});
