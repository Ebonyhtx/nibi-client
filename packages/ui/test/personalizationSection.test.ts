// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const read = vi.fn();
  const write = vi.fn();
  const service = { readUserAgentsFile: read, writeUserAgentsFile: write };
  // 稳定引用：设置页 hook 依赖 service / intl 身份；mock 每次返回新对象会让加载 effect 无限重跑。
  const services = { settingsSyncService: service };
  const intlContext = {
    intl: {
      formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
        values
          ? `${id}:${Object.entries(values)
              .map(([key, value]) => `${key}=${value}`)
              .join(",")}`
          : id,
    },
  };
  return { read, write, service, services, intlContext, toast: vi.fn() };
});

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => h.services,
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useNibiIntl: () => h.intlContext,
}));

vi.mock("@/components/ui/toast.js", () => ({ toast: h.toast }));

import { PersonalizationSection } from "@/settings/PersonalizationSection.js";

const PATH = "/home/me/.nibi/AGENTS.md";

function mockLoadedFile(content: string) {
  h.read.mockResolvedValue({ path: PATH, content, exists: true });
  h.write.mockImplementation(async ({ content: next }: { content: string }) => ({
    path: PATH,
    bytes: new TextEncoder().encode(next).byteLength,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadedFile("old content");
});

afterEach(() => {
  cleanup();
});

describe("PersonalizationSection", () => {
  it("加载用户级 AGENTS.md，未修改时保存禁用，修改后保存", async () => {
    render(createElement(PersonalizationSection));
    const editor = (await screen.findByTestId(
      "settings-personalization-editor",
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe("old content"));

    const save = screen.getByTestId("settings-personalization-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText(`settings.personalization.size:used=0,limit=100`)).toBeTruthy();

    fireEvent.change(editor, { target: { value: "new content" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(h.write).toHaveBeenCalledWith({ content: "new content" }));
    await waitFor(() => expect(h.toast).toHaveBeenCalled());
  });

  it("超过 100 KB 时显示错误并禁用保存", async () => {
    render(createElement(PersonalizationSection));
    const editor = (await screen.findByTestId(
      "settings-personalization-editor",
    )) as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe("old content"));

    fireEvent.change(editor, { target: { value: "a".repeat(100 * 1024 + 1) } });

    expect(screen.getByText("settings.personalization.overLimit")).toBeTruthy();
    expect(
      (screen.getByTestId("settings-personalization-save") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("读取失败时显示错误与重试，不提供可编辑草稿", async () => {
    h.read.mockRejectedValueOnce(new Error("EACCES"));
    render(createElement(PersonalizationSection));

    await screen.findByText("settings.personalization.loadFailed");
    expect(screen.queryByTestId("settings-personalization-editor")).toBeNull();
    expect(screen.getByText("common.retry")).toBeTruthy();
  });
});
