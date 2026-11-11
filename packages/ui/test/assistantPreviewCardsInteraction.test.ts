// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantPreviewCards } from "@/AssistantPreviewCards.js";
import type { AssistantPreviewCard } from "@/lib/assistantPreviewCards.js";

const state = vi.hoisted(() => ({
  openExternal: vi.fn(),
  openExternalFile: vi.fn(),
  openInFileManager: vi.fn(),
  openInEditor: vi.fn(),
  getInstalledEditors: vi.fn(),
}));

// 预览卡片本身会经 useWorkspaceServices 解析 fileService；本文件只用无 stat 的
// website 卡片，validation 在首个渲染就同步 settle，不需要真实 RPC。
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useWorkspaceServices: () => ({
    fileService: { checkFilesExist: async () => [] },
  }),
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    canOpenLocalFiles: false,
    openExternal: state.openExternal,
    openExternalFile: state.openExternalFile,
    openInFileManager: state.openInFileManager,
    openInEditor: state.openInEditor,
    getInstalledEditors: state.getInstalledEditors,
  }),
}));
vi.mock("@/hooks/useWorkspaceOpenInEditorTarget.js", () => ({
  useWorkspaceOpenInEditorTarget: () => ({
    isRemoteWorkspace: false,
    remoteTarget: undefined,
  }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

const card: AssistantPreviewCard = {
  id: "website:http://localhost:5173",
  type: "website",
  title: "Neon Snake",
  subtitleId: "chat.previewCards.website",
  url: "http://localhost:5173",
};

function mount() {
  const onOpenBrowserUrl = vi.fn();
  render(
    createElement(AssistantPreviewCards, {
      cards: [card],
      onOpenBrowserUrl,
    }),
  );
  return onOpenBrowserUrl;
}

/**
 * jsdom 29 不实现原生 button 的键盘激活：Enter keydown 不会自动派发 click。
 * 按浏览器语义补上 click，但只对真正的 `<button>` 生效——如果实现退化成
 * div + role="button"，这里不会产生点击，用例即失败。
 */
function pressEnter(element: HTMLElement) {
  element.focus();
  expect(document.activeElement).toBe(element);
  fireEvent.keyDown(element, { key: "Enter", code: "Enter" });
  if (element instanceof HTMLButtonElement) {
    element.click();
  }
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  state.getInstalledEditors.mockResolvedValue([]);
});

describe("assistant preview card whole-card click", () => {
  it("点击整卡命中层触发一次与主按钮相同的预览", () => {
    // 正文层是 pointer-events-none，浏览器命中测试会落到铺满卡片的透明 button；
    // jsdom 不实现命中测试，所以用例直接点击这个命中层。
    const preview = mount();
    const hitArea = screen.getByRole("button", { name: card.title });

    fireEvent.click(hitArea);

    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith(card.url);
  });

  it("点击内部 Open 按钮只执行自身动作，不冒泡出第二次预览", () => {
    const preview = mount();

    fireEvent.click(screen.getByRole("button", { name: "common.open" }));

    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith(card.url);
  });

  it("点击下拉入口只打开菜单，不触发整卡预览", async () => {
    const preview = mount();

    fireEvent.pointerDown(screen.getByLabelText("appHeader.selectOpenApp"), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByText("chat.previewCards.openExternal"));

    expect(state.openExternal).toHaveBeenCalledWith(card.url);
    expect(preview).not.toHaveBeenCalled();
  });

  it("整卡可聚焦并用 Enter 触发预览", () => {
    const preview = mount();
    const hitArea = screen.getByRole("button", { name: card.title });

    pressEnter(hitArea);

    expect(preview).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledWith(card.url);
  });
});
