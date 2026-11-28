// @vitest-environment jsdom

import { createElement } from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";

afterEach(cleanup);

describe("submenu portal rendering", () => {
  it("renders DropdownMenuSubContent outside DropdownMenuContent to prevent backdrop-filter clipping", () => {
    render(
      createElement(
        DropdownMenu,
        { open: true },
        createElement(DropdownMenuTrigger, { type: "button" }, "Account"),
        createElement(
          DropdownMenuContent,
          null,
          createElement(
            DropdownMenuSub,
            { open: true },
            createElement(DropdownMenuSubTrigger, null, "Theme"),
            createElement(
              DropdownMenuSubContent,
              null,
              createElement(DropdownMenuItem, null, "Warm Paper"),
            ),
          ),
        ),
      ),
    );

    const parentMenu = document.querySelector('[data-slot="dropdown-menu-content"]');
    const subMenu = document.querySelector('[data-slot="dropdown-menu-sub-content"]');

    expect(parentMenu).not.toBeNull();
    expect(subMenu).not.toBeNull();
    expect(parentMenu?.contains(subMenu)).toBe(false);
    expect(document.body.contains(subMenu)).toBe(true);
  });

  it("renders ContextMenuSubContent inside a portal outside ContextMenuContent", () => {
    render(
      createElement(
        ContextMenu,
        null,
        createElement(ContextMenuTrigger, null, "Row"),
        createElement(
          ContextMenuContent,
          null,
          createElement(
            ContextMenuSub,
            { open: true },
            createElement(ContextMenuSubTrigger, null, "More"),
            createElement(
              ContextMenuSubContent,
              null,
              createElement(ContextMenuItem, null, "Inspect"),
            ),
          ),
        ),
      ),
    );

    const trigger = document.querySelector('[data-slot="context-menu-trigger"]') as HTMLElement;
    expect(trigger).not.toBeNull();
    fireEvent.contextMenu(trigger, { clientX: 40, clientY: 40 });

    const parentMenu = document.querySelector('[data-slot="context-menu-content"]');
    const subMenu = document.querySelector('[data-slot="context-menu-sub-content"]');

    expect(parentMenu).not.toBeNull();
    expect(subMenu).not.toBeNull();
    expect(parentMenu?.contains(subMenu)).toBe(false);
    expect(document.body.contains(subMenu)).toBe(true);
  });
});
