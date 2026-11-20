// @vitest-environment jsdom
import { createElement, Fragment, useEffect } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { SettingsSectionId } from "@/lib/settingsNavigation.js";
import {
  SettingsSectionPane,
  retainSettingsSections,
  useRetainedSettingsSections,
} from "@/settings/SettingsSectionKeepAlive.js";

afterEach(cleanup);

const mounts = new Map<SettingsSectionId, number>();
const unmounts = new Map<SettingsSectionId, number>();

function TestSection({ section }: { section: SettingsSectionId }) {
  useEffect(() => {
    mounts.set(section, (mounts.get(section) ?? 0) + 1);
    return () => {
      unmounts.set(section, (unmounts.get(section) ?? 0) + 1);
    };
  }, [section]);
  return createElement("button", { type: "button" }, section);
}

function Harness({ section }: { section: SettingsSectionId }) {
  const retained = useRetainedSettingsSections(section);
  return createElement(
    Fragment,
    null,
    // 与 SettingsPage 相同：当前分区排最后，隐藏分区在前。
    ...retained
      .toReversed()
      .map((id) =>
        createElement(
          SettingsSectionPane,
          { key: id, section: id, active: id === section },
          createElement(TestSection, { section: id }),
        ),
      ),
  );
}

function paneFor(section: SettingsSectionId): HTMLElement {
  const pane = document.querySelector<HTMLElement>(`[data-settings-section-pane="${section}"]`);
  if (!pane) throw new Error(`pane not found: ${section}`);
  return pane;
}

describe("settings section keep-alive", () => {
  it("retains at most the current and the most recent section", () => {
    expect(retainSettingsSections({ current: "general", previous: null })).toEqual(["general"]);
    expect(retainSettingsSections({ current: "plugin", previous: "general" })).toEqual([
      "plugin",
      "general",
    ]);
    expect(retainSettingsSections({ current: "plugin", previous: "plugin" })).toEqual(["plugin"]);
  });

  it("mounts lazily, keeps the previous section mounted, and never remounts on switch", () => {
    mounts.clear();
    unmounts.clear();
    const { rerender } = render(createElement(Harness, { section: "general" }));
    expect(mounts.get("general")).toBe(1);
    expect(mounts.get("plugin")).toBeUndefined();
    const generalNode = paneFor("general");
    expect(generalNode.hidden).toBe(false);

    rerender(createElement(Harness, { section: "plugin" }));
    // 首次访问 plugin 才挂载；general 作为最近一个分区保活。
    expect(mounts.get("plugin")).toBe(1);
    expect(mounts.get("general")).toBe(1);
    expect(unmounts.get("general")).toBeUndefined();
    expect(paneFor("plugin").hidden).toBe(false);
    expect(paneFor("general").hidden).toBe(true);
    // hidden 之外还必须是 inert + aria-hidden：不可聚焦、不会被读屏读到。
    expect(paneFor("general").hasAttribute("inert")).toBe(true);
    expect(paneFor("general").getAttribute("aria-hidden")).toBe("true");
    expect(paneFor("plugin").hasAttribute("inert")).toBe(false);

    rerender(createElement(Harness, { section: "general" }));
    // 切回来不重建：同一个 DOM 节点、挂载计数不变。
    expect(paneFor("general")).toBe(generalNode);
    expect(mounts.get("general")).toBe(1);
    expect(mounts.get("plugin")).toBe(1);
    expect(paneFor("general").hidden).toBe(false);
    expect(paneFor("plugin").hidden).toBe(true);

    // 第三个分区进入时，只保留当前 + 最近访问（general）；plugin 被卸载。
    rerender(createElement(Harness, { section: "mcp" }));
    expect(mounts.get("mcp")).toBe(1);
    expect(unmounts.get("plugin")).toBe(1);
    expect(mounts.get("general")).toBe(1);
    expect(document.querySelector('[data-settings-section-pane="plugin"]')).toBeNull();
    expect(paneFor("general").hidden).toBe(true);
    expect(paneFor("mcp").hidden).toBe(false);
  });

  it("starts on a deep-linked section without mounting the default one", () => {
    mounts.clear();
    unmounts.clear();
    render(createElement(Harness, { section: "plugin" }));
    expect(mounts.get("plugin")).toBe(1);
    expect(mounts.get("general")).toBeUndefined();
    expect(paneFor("plugin").hidden).toBe(false);
  });
});
