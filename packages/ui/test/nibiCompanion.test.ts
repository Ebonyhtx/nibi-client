// @vitest-environment jsdom
import { act, createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  motionDisabled: false,
}));

vi.mock("@/store/nibiSessionStore.js", () => ({
  selectWorkspaceNibiState: () => ({
    activeTaskId: null,
    taskRuntimeByTaskId: {},
  }),
  useNibiSessionStore: (selector: (state: unknown) => unknown) => selector({}),
}));

vi.mock("@/lib/motionPreference.js", () => ({
  useMotionDisabled: () => hoisted.motionDisabled,
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({}),
}));

import { NibiCompanion } from "@/companion/NibiCompanion.js";
import { setCompanionPreference } from "@/companion/companionPreferences.js";

function resetCompanionPreferences() {
  setCompanionPreference("visible", true);
  setCompanionPreference("mode", "auto");
  setCompanionPreference("follow", true);
  setCompanionPreference("feathers", true);
  setCompanionPreference("animation", "inherit");
}

beforeEach(() => {
  hoisted.motionDisabled = false;
  resetCompanionPreferences();
});

afterEach(() => {
  cleanup();
  resetCompanionPreferences();
});

describe("NibiCompanion (Paper & Ink Atelier)", () => {
  it("renders default idle pose without legacy video layers and includes sumi perch stroke", () => {
    const { container } = render(createElement(NibiCompanion, { workspacePath: "/tmp/demo" }));
    const anchor = container.querySelector<HTMLElement>(".companion-anchor");
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("data-companion-pose")).toBe("idle");
    expect(anchor?.getAttribute("data-companion-state")).toBe("idle");
    expect(container.querySelectorAll("video")).toHaveLength(0);
    expect(container.querySelector(".companion-perch-zone svg.companion-perch-stroke")).not.toBeNull();
    expect(
      container.querySelector(".companion-pose-layer--idle.is-current img"),
    ).not.toBeNull();
  });

  it("maps explicit mode preferences to matching Paper & Ink poses", () => {
    const { container } = render(createElement(NibiCompanion, { workspacePath: "/tmp/demo" }));
    const cases = [
      ["perch", "hero"],
      ["working", "fly"],
      ["complete", "respond"],
      ["paused", "paused"],
    ] as const;

    for (const [mode, expectedPose] of cases) {
      act(() => {
        setCompanionPreference("mode", mode);
      });
      const anchor = container.querySelector<HTMLElement>(".companion-anchor");
      expect(anchor?.getAttribute("data-companion-pose")).toBe(expectedPose);
      expect(
        container.querySelector(`.companion-pose-layer--${expectedPose}.is-current`),
      ).not.toBeNull();
    }
  });

  it("hides companion when visible is false", () => {
    const { container } = render(createElement(NibiCompanion, { workspacePath: "/tmp/demo" }));
    act(() => {
      setCompanionPreference("visible", false);
    });
    expect(container.querySelector(".companion-anchor")).toBeNull();
  });

  it("toggles Atelier SVG feather wisps when feathers preference changes", () => {
    const { container } = render(createElement(NibiCompanion, { workspacePath: "/tmp/demo" }));
    expect(container.querySelectorAll(".companion-feathers svg")).toHaveLength(4);
    act(() => {
      setCompanionPreference("feathers", false);
    });
    expect(container.querySelectorAll(".companion-feathers svg")).toHaveLength(0);
  });

  it("applies is-motion-reduced when animation preference is off", () => {
    const { container } = render(createElement(NibiCompanion, { workspacePath: "/tmp/demo" }));
    act(() => {
      setCompanionPreference("animation", "off");
    });
    const anchor = container.querySelector<HTMLElement>(".companion-anchor");
    expect(anchor?.classList.contains("is-motion-reduced")).toBe(true);
  });
});
