// @vitest-environment jsdom

import { createElement } from "react";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceProvider } from "@/hooks/useServices.js";
import { NibiIntlProvider } from "@/i18n/IntlProvider.js";
import { parseMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { ConversationUserInputContent } from "@/v4/ConversationUserInputContent.js";
import { ImageFilePreviewScopeContext } from "@/v4/imageFilePreviewContext.js";

interface DialogItem {
  alt: string;
  error?: boolean;
  filename?: string;
  loading?: boolean;
  src?: string;
}

interface DialogProps {
  initialIndex: number;
  items: readonly DialogItem[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
}

const { dialogProps } = vi.hoisted(() => ({
  dialogProps: [] as DialogProps[],
}));

vi.mock("@/components/ai-elements/image-preview-dialog.js", () => ({
  ImagePreviewDialog: (props: DialogProps) => {
    dialogProps.push(props);
    return null;
  },
}));

afterEach(() => {
  dialogProps.length = 0;
  vi.restoreAllMocks();
});

function renderMention(
  text: string,
  options: {
    workspacePath?: string;
    readMediaPreview?: (params: { path: string }) => Promise<{
      path: string;
      mediaType: string;
      dataBase64: string;
      totalBytes: number;
    }>;
  } = {},
) {
  const readMediaPreview =
    options.readMediaPreview ??
    vi.fn().mockImplementation(async ({ path }: { path: string }) => ({
      path,
      mediaType: "image/png",
      dataBase64: "aW1hZ2U=",
      totalBytes: 5,
    }));
  const view = render(
    createElement(
      NibiIntlProvider,
      { initialLocale: "en-US" },
      createElement(
        ServiceProvider,
        { services: { fileService: { readMediaPreview } } as never },
        createElement(
          ImageFilePreviewScopeContext.Provider,
          { value: { workspacePath: options.workspacePath ?? "/workspace" } },
          createElement(ConversationUserInputContent, { text }),
        ),
      ),
    ),
  );
  return { ...view, readMediaPreview };
}

function lastDialog(): DialogProps | undefined {
  return dialogProps.at(-1);
}

describe("mention markdown destinations", () => {
  it("keeps the markdown destination for file mentions", () => {
    expect(parseMentionMarkdown("[photo.png](./images/photo.png)")).toEqual([
      { type: "file", label: "photo.png", href: "./images/photo.png" },
    ]);
    expect(parseMentionMarkdown("[absolute.png](/data/images/absolute.png)")).toEqual([
      { type: "file", label: "absolute.png", href: "/data/images/absolute.png" },
    ]);
  });

  it("keeps Windows and angle-bracket destinations without changing the label", () => {
    expect(parseMentionMarkdown("[小桥.jpg](<C:\\work\\images\\小桥.jpg>)")).toEqual([
      { type: "file", label: "小桥.jpg", href: "C:\\work\\images\\小桥.jpg" },
    ]);
    expect(parseMentionMarkdown("[photo.png](foo\\)bar.png)")).toEqual([
      { type: "file", label: "photo.png", href: "foo)bar.png" },
    ]);
  });

  it("does not turn non-file mention identities into file destinations", () => {
    expect(parseMentionMarkdown("[#Review](#sess_session-a)")).toEqual([
      { type: "session", label: "Review" },
    ]);
    expect(parseMentionMarkdown("[@skill-creator](plugin://skill-creator@official)")).toEqual([
      { type: "plugin", label: "skill-creator", pluginId: "skill-creator@official" },
    ]);
    expect(parseMentionMarkdown("[$code-review](./skills/code-review/SKILL.md)")).toEqual([
      { type: "skill", label: "code-review" },
    ]);
  });
});

describe("image file mentions in user input", () => {
  it("renders an image file mention as a button that opens the preview dialog", async () => {
    const view = renderMention("看看 [photo.png](./images/photo.png) 这张图");
    const button = view.container.querySelector<HTMLButtonElement>("[data-image-file-mention]");

    expect(button).not.toBeNull();
    expect(button?.tagName).toBe("BUTTON");
    expect(button?.getAttribute("aria-haspopup")).toBe("dialog");
    expect(button?.getAttribute("aria-label")).toContain("photo.png");
    expect(lastDialog()?.open).toBe(false);

    fireEvent.click(button as HTMLButtonElement);

    await waitFor(() =>
      expect(view.readMediaPreview).toHaveBeenCalledWith({ path: "/workspace/images/photo.png" }),
    );
    await waitFor(() => expect(lastDialog()?.open).toBe(true));
    expect(lastDialog()?.items).toEqual([
      {
        alt: "photo.png",
        error: false,
        filename: "photo.png",
        loading: false,
        src: "data:image/png;base64,aW1hZ2U=",
      },
    ]);
  });

  it("keeps non-image file mentions as a non-interactive span", () => {
    const view = renderMention("看看 [README.md](./README.md) 这个文件");
    const first = view.container.firstElementChild;

    expect(view.container.querySelector("[data-image-file-mention]")).toBeNull();
    expect(view.container.querySelector("button")).toBeNull();
    expect(first?.tagName).toBe("SPAN");
    expect(first?.textContent).toContain("README.md");
    expect(dialogProps.some((props) => props.open)).toBe(false);
    expect(view.readMediaPreview).not.toHaveBeenCalled();
  });

  it("does not make an unresolvable image path interactive", () => {
    const view = renderMention(
      "看看 [escaped.png](../outside.png) 和 [remote.png](https://example.test/remote.png)",
    );

    expect(view.container.querySelector("[data-image-file-mention]")).toBeNull();
    expect(view.container.querySelectorAll("button")).toHaveLength(0);
    expect(dialogProps.some((props) => props.open)).toBe(false);
    expect(view.readMediaPreview).not.toHaveBeenCalled();
  });

  it("resolves absolute destinations against the workspace host without rebasing them", async () => {
    const view = renderMention("[absolute.png](/data/images/absolute.png)");
    const button = view.container.querySelector<HTMLButtonElement>("[data-image-file-mention]");

    fireEvent.click(button as HTMLButtonElement);

    await waitFor(() =>
      expect(view.readMediaPreview).toHaveBeenCalledWith({ path: "/data/images/absolute.png" }),
    );
    expect(view.readMediaPreview).not.toHaveBeenCalledWith({
      path: "/workspace/data/images/absolute.png",
    });
  });

  it("shows an honest error state for a missing image instead of a fake preview", async () => {
    const readMediaPreview = vi.fn().mockRejectedValue(new Error("file not found"));
    const view = renderMention("[missing.png](./images/missing.png)", { readMediaPreview });
    const button = view.container.querySelector<HTMLButtonElement>("[data-image-file-mention]");

    fireEvent.click(button as HTMLButtonElement);

    await waitFor(() => expect(lastDialog()?.open).toBe(true));
    await waitFor(() => expect(lastDialog()?.items[0]?.error).toBe(true));
    expect(lastDialog()?.items[0]?.src).toBeUndefined();
    expect(readMediaPreview).toHaveBeenCalledTimes(1);
  });
});
