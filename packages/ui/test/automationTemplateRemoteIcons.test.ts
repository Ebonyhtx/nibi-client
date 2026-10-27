// @vitest-environment jsdom

import { createElement } from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AutomationScheduledTemplateIcon } from "@/settings/AutomationScheduledTemplateIcon.js";

describe("automation template Client Scenes icons", () => {
  it("renders a scheduled img value as a Lucide icon name and inherits color", async () => {
    const view = render(
      createElement(
        "span",
        { className: "text-foreground" },
        createElement(AutomationScheduledTemplateIcon, {
          iconName: "calendar-clock",
          name: "target",
        }),
      ),
    );

    await waitFor(() => {
      expect(
        view.container.querySelector('[data-client-scene-lucide-icon="calendar-clock"]'),
      ).not.toBeNull();
    });
    expect(view.container.querySelector("img")).toBeNull();
    expect(view.container.querySelector("svg.lucide-target")).toBeNull();
  });


});
