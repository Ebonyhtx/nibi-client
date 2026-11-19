// @vitest-environment jsdom
import { createElement } from "react";
import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IServiceAccessor } from "@nibi/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useSelectionCommentSupport } from "@/selection-comment/index.js";

function servicesWith(supports?: (target: unknown) => Promise<boolean>): IServiceAccessor {
  return {
    nibiAgentService: supports ? { supportsConversationQuoteComment: supports } : {},
  } as unknown as IServiceAccessor;
}

function Probe({ enabled = true }: { enabled?: boolean }) {
  const supported = useSelectionCommentSupport("/workspace", undefined, enabled);
  return createElement("span", { "data-supported": String(supported) });
}

function renderProbe(services: IServiceAccessor, enabled = true) {
  return render(createElement(ServiceProvider, { services }, createElement(Probe, { enabled })));
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("useSelectionCommentSupport", () => {
  it("only enables annotations when the CLI declares conversationQuoteComment", async () => {
    const supports = vi.fn(async () => true);
    const { container } = renderProbe(servicesWith(supports));
    expect(container.querySelector("span")?.dataset.supported).toBe("false");
    await waitFor(() => {
      expect(container.querySelector("span")?.dataset.supported).toBe("true");
    });
    expect(supports).toHaveBeenCalledWith({ workspacePath: "/workspace" });
  });

  it("stays hidden when the Host has no capability query", () => {
    const { container } = renderProbe(servicesWith());
    expect(container.querySelector("span")?.dataset.supported).toBe("false");
  });

  it("stays hidden when the query rejects", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const supports = vi.fn(async () => {
      throw new Error("old host");
    });
    const { container } = renderProbe(servicesWith(supports));
    await waitFor(() => {
      expect(supports).toHaveBeenCalled();
    });
    expect(container.querySelector("span")?.dataset.supported).toBe("false");
  });

  it("does not query when the caller is disabled", () => {
    const supports = vi.fn(async () => true);
    const { container } = renderProbe(servicesWith(supports), false);
    expect(container.querySelector("span")?.dataset.supported).toBe("false");
    expect(supports).not.toHaveBeenCalled();
  });
});
