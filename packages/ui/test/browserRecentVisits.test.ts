// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TID_BROWSER_RECENT_VISIT_ITEM,
  TID_BROWSER_RECENT_VISIT_REMOVE,
  TID_BROWSER_RECENT_VISITS,
} from "@nibi/shared/test-ids";
import { BrowserEmptyState } from "@/EmbeddedBrowserPaneParts.js";
import { INITIAL_BROWSER_STATE } from "@/embeddedBrowserHelpers.js";
import {
  BROWSER_RECENT_VISITS_LIMIT,
  BROWSER_RECENT_VISITS_STORAGE_KEY,
  clearBrowserRecentVisits,
  clearBrowserRecentVisitsAfterDataClear,
  recordBrowserRecentVisit,
  removeBrowserRecentVisit,
} from "@/lib/browserRecentVisits.js";

function storedVisits(): Array<{
  url: string;
  title?: string;
  faviconUrl?: string;
  visitedAt: number;
  workspaceKey: string;
}> {
  const raw = localStorage.getItem(BROWSER_RECENT_VISITS_STORAGE_KEY);
  return raw ? JSON.parse(raw) : [];
}

beforeEach(() => {
  localStorage.clear();
  clearBrowserRecentVisits();
});

describe("browser recent visits", () => {
  it("只记录 http/https URL", () => {
    recordBrowserRecentVisit({ url: "javascript:alert(1)", workspaceKey: "ws" });
    recordBrowserRecentVisit({ url: "file:///tmp/page.html", workspaceKey: "ws" });
    recordBrowserRecentVisit({ url: "about:blank", workspaceKey: "ws" });
    recordBrowserRecentVisit({ url: "mailto:a@example.com", workspaceKey: "ws" });

    expect(storedVisits()).toEqual([]);

    recordBrowserRecentVisit({
      url: "http://example.com/a",
      workspaceKey: "ws",
      visitedAt: 1,
    });
    recordBrowserRecentVisit({
      url: "https://example.com/b",
      workspaceKey: "ws",
      visitedAt: 2,
    });

    expect(storedVisits().map((visit) => visit.url)).toEqual([
      "https://example.com/b",
      "http://example.com/a",
    ]);
  });

  it("按 URL 去重并移到最前，后续 title/favicon 补齐已有条目", () => {
    recordBrowserRecentVisit({
      url: "https://example.com/a",
      workspaceKey: "ws",
      visitedAt: 1,
    });
    recordBrowserRecentVisit({
      url: "https://example.com/b",
      workspaceKey: "ws",
      visitedAt: 2,
    });
    recordBrowserRecentVisit({
      url: "https://example.com/a",
      workspaceKey: "ws",
      title: "Page A",
      faviconUrl: "https://example.com/favicon.ico",
      visitedAt: 3,
    });

    const visits = storedVisits();
    expect(visits).toHaveLength(2);
    expect(visits[0]).toMatchObject({
      url: "https://example.com/a",
      title: "Page A",
      faviconUrl: "https://example.com/favicon.ico",
      visitedAt: 3,
    });

    recordBrowserRecentVisit({
      url: "https://example.com/a",
      workspaceKey: "ws",
      visitedAt: 4,
    });
    expect(storedVisits()[0]).toMatchObject({
      title: "Page A",
      faviconUrl: "https://example.com/favicon.ico",
      visitedAt: 4,
    });
  });

  it("最多保留 20 条，最新访问在前", () => {
    for (let index = 0; index < BROWSER_RECENT_VISITS_LIMIT + 5; index += 1) {
      recordBrowserRecentVisit({
        url: `https://example.com/${index}`,
        workspaceKey: "ws",
        visitedAt: index,
      });
    }

    const visits = storedVisits();
    expect(visits).toHaveLength(BROWSER_RECENT_VISITS_LIMIT);
    expect(visits[0]?.url).toBe(`https://example.com/${BROWSER_RECENT_VISITS_LIMIT + 4}`);
    expect(visits.at(-1)?.url).toBe("https://example.com/5");
  });

  it("支持单条删除与全部清除", () => {
    recordBrowserRecentVisit({
      url: "https://example.com/a",
      workspaceKey: "ws",
      visitedAt: 1,
    });
    recordBrowserRecentVisit({
      url: "https://example.com/b",
      workspaceKey: "ws",
      visitedAt: 2,
    });

    removeBrowserRecentVisit("https://example.com/a");
    expect(storedVisits().map((visit) => visit.url)).toEqual(["https://example.com/b"]);

    clearBrowserRecentVisits();
    expect(storedVisits()).toEqual([]);
  });

  it("损坏或越界的持久化数据不会污染列表", () => {
    localStorage.setItem(
      BROWSER_RECENT_VISITS_STORAGE_KEY,
      JSON.stringify([
        "junk",
        { url: "ftp://example.com", workspaceKey: "ws", visitedAt: 1 },
        { url: "https://example.com/ok", workspaceKey: "ws", visitedAt: 2 },
        { url: "https://example.com/ok", workspaceKey: "ws", visitedAt: 3 },
      ]),
    );
    recordBrowserRecentVisit({
      url: "https://example.com/new",
      workspaceKey: "ws",
      visitedAt: 4,
    });

    expect(storedVisits().map((visit) => visit.url)).toEqual([
      "https://example.com/new",
      "https://example.com/ok",
    ]);
  });

  it("清理全部站点数据成功才清除最近访问，清缓存不影响", () => {
    recordBrowserRecentVisit({
      url: "https://example.com/a",
      workspaceKey: "ws",
      visitedAt: 1,
    });

    clearBrowserRecentVisitsAfterDataClear("cache", true);
    expect(storedVisits()).toHaveLength(1);

    clearBrowserRecentVisitsAfterDataClear("all", false);
    expect(storedVisits()).toHaveLength(1);

    clearBrowserRecentVisitsAfterDataClear("all", true);
    expect(storedVisits()).toEqual([]);
  });
});

afterEach(() => {
  cleanup();
});

describe("browser empty state recent visits", () => {
  function renderEmptyState(enableRecentVisits: boolean) {
    const onOpenRecentVisit = vi.fn();
    render(
      createElement(BrowserEmptyState, {
        browserState: INITIAL_BROWSER_STATE,
        formatMessage: ({ id }: { id: string }) => id,
        enableRecentVisits,
        onOpenRecentVisit,
      }),
    );
    return onOpenRecentVisit;
  }

  it("human 空态按最近访问顺序展示，点击打开、单条删除", () => {
    recordBrowserRecentVisit({
      url: "https://example.com/a",
      workspaceKey: "ws",
      title: "Page A",
      visitedAt: 1,
    });
    recordBrowserRecentVisit({
      url: "https://example.com/b",
      workspaceKey: "ws",
      title: "Page B",
      visitedAt: 2,
    });

    const onOpenRecentVisit = renderEmptyState(true);
    expect(screen.getByTestId(TID_BROWSER_RECENT_VISITS)).toBeTruthy();
    expect(screen.getByText("Page B")).toBeTruthy();
    expect(screen.getByText("Page A")).toBeTruthy();

    const items = screen.getAllByTestId(TID_BROWSER_RECENT_VISIT_ITEM);
    expect(items).toHaveLength(2);
    fireEvent.click(items[0]!);
    expect(onOpenRecentVisit).toHaveBeenCalledWith("https://example.com/b");

    fireEvent.click(screen.getAllByTestId(TID_BROWSER_RECENT_VISIT_REMOVE)[0]!);
    expect(storedVisits().map((visit) => visit.url)).toEqual(["https://example.com/a"]);
    expect(screen.getAllByTestId(TID_BROWSER_RECENT_VISIT_ITEM)).toHaveLength(1);

    fireEvent.click(screen.getByText("browser.recentVisits.clear"));
    expect(storedVisits()).toEqual([]);
    expect(screen.queryByTestId(TID_BROWSER_RECENT_VISITS)).toBeNull();
  });

  it("agent tab 与无历史时不渲染最近访问", () => {
    recordBrowserRecentVisit({
      url: "https://example.com/a",
      workspaceKey: "ws",
      visitedAt: 1,
    });
    renderEmptyState(false);
    expect(screen.queryByTestId(TID_BROWSER_RECENT_VISITS)).toBeNull();

    cleanup();
    clearBrowserRecentVisits();
    renderEmptyState(true);
    expect(screen.queryByTestId(TID_BROWSER_RECENT_VISITS)).toBeNull();
  });
});
