// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { isMotionDisabled } = vi.hoisted(() => ({
  isMotionDisabled: vi.fn(() => false),
}));

vi.mock("@/lib/motionPreference.js", () => ({ isMotionDisabled }));

import {
  findArchiveTaskRowRect,
  findTaskRowRect,
  playNibiFeatherFall,
  playNibiFeatherFallFromRect,
} from "@/lib/nibiFeatherFall.js";

let now = 0;
let rafCallback: FrameRequestCallback | null = null;

beforeEach(() => {
  isMotionDisabled.mockReturnValue(false);
  document.body.replaceChildren();
  now = 0;
  rafCallback = null;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      rafCallback = callback;
      return 1;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  if (rafCallback) {
    now = 100_000;
    rafCallback(now);
  }
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("playNibiFeatherFall", () => {
  it("spawns a staggered feather group and cleans it up after the flight", () => {
    playNibiFeatherFall({ x: 200, y: 200 });

    const feathers = Array.from(
      document.querySelectorAll<HTMLImageElement>("[data-nibi-feather-fall]"),
    );
    expect(feathers).toHaveLength(3);
    expect(feathers.every((feather) => feather.style.position === "fixed")).toBe(true);
    expect(feathers.every((feather) => feather.style.pointerEvents === "none")).toBe(true);
    expect(feathers.every((feather) => feather.style.opacity === "0")).toBe(true);
    expect(requestAnimationFrame).toHaveBeenCalled();

    now = 500;
    rafCallback?.(now);
    const first = document.querySelector<HTMLImageElement>("[data-nibi-feather-fall]");
    expect(first?.style.transform).toContain("translate3d");
    expect(Number(first?.style.opacity)).toBeGreaterThan(0);

    now = 3_000;
    rafCallback?.(now);
    expect(document.querySelectorAll("[data-nibi-feather-fall]")).toHaveLength(0);
  });

  it("does nothing when motion is disabled", () => {
    isMotionDisabled.mockReturnValue(true);
    playNibiFeatherFall({ x: 200, y: 200 });

    expect(document.querySelectorAll("[data-nibi-feather-fall]")).toHaveLength(0);
    expect(requestAnimationFrame).not.toHaveBeenCalled();
  });
});

describe("playNibiFeatherFallFromRect", () => {
  it("centres the first feather just outside the source rect", () => {
    playNibiFeatherFallFromRect({ right: 100, top: 40, height: 40 } as DOMRect);

    const first = document.querySelector<HTMLImageElement>("[data-nibi-feather-fall]");
    expect(parseFloat(first?.style.left ?? "0")).toBeCloseTo(77, 0);
    expect(parseFloat(first?.style.top ?? "0")).toBeCloseTo(31.2, 0);
  });
});

describe("task row lookup", () => {
  it("finds classic and grouped task rows by the shared task-item test id", () => {
    const row = document.createElement("div");
    row.setAttribute("data-testid", "task-item-task-1");
    const rect = { right: 120, top: 40, height: 32 } as DOMRect;
    row.getBoundingClientRect = () => rect;
    document.body.append(row);

    expect(findTaskRowRect("task-1")).toBe(rect);
    expect(findTaskRowRect("missing")).toBeNull();
  });

  it("finds archive rows by task id", () => {
    const row = document.createElement("div");
    row.setAttribute("data-testid", "archive-task");
    row.setAttribute("data-task-id", "task-2");
    const rect = { right: 120, top: 40, height: 32 } as DOMRect;
    row.getBoundingClientRect = () => rect;
    document.body.append(row);

    expect(findArchiveTaskRowRect("task-2")).toBe(rect);
  });
});
