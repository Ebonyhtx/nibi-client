import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NibiEmptyStateArt } from "@/components/NibiEmptyStateArt.js";

describe("NibiEmptyStateArt", () => {
  it.each(["automation", "archive", "feedback"] as const)(
    "renders the %s variant with the NIBI bird",
    (variant) => {
      const html = renderToStaticMarkup(createElement(NibiEmptyStateArt, { variant }));

      expect(html).toContain(`data-nibi-empty-state-art="${variant}"`);
      expect(html).toContain("<svg");
      expect(html).toContain("nibi-perched");
    },
  );
});
