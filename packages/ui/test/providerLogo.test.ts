// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  hasBuiltinProviderLogoAsset,
  ProviderLogo,
  resolveBuiltinProviderLogoAsset,
} from "@/settings/model-provider-section/ProviderLogo.js";

describe("ProviderLogo", () => {
  it("解析已知资源，并让未知或缺失 key 回退通用图标", () => {
    expect(resolveBuiltinProviderLogoAsset({ type: "builtin", key: "deepseek" }, "light")).toBe(
      resolveBuiltinProviderLogoAsset({ type: "builtin", key: "deepseek" }, "dark"),
    );
    expect(resolveBuiltinProviderLogoAsset({ type: "builtin", key: "future-brand" }, "light")).toBe(
      null,
    );
    expect(resolveBuiltinProviderLogoAsset(undefined, "light")).toBe(null);

    const known = renderToStaticMarkup(
      createElement(ProviderLogo, {
        logo: { type: "builtin", key: "deepseek" },
        className: "size-5",
      }),
    );
    const unknown = renderToStaticMarkup(
      createElement(ProviderLogo, {
        logo: { type: "builtin", key: "future-brand" },
        className: "size-5",
      }),
    );
    expect(known).toContain("<img");
    expect(known).toContain('alt=""');
    expect(unknown).toContain("lucide-package");
  });

  it("配置里的每个内置 logo key 都有打包素材", () => {
    const config = JSON.parse(
      readFileSync(join(process.cwd(), "config/provider/nibi-builtin.json"), "utf8"),
    ) as {
      config: {
        providerConfigRules: {
          templateRules: Array<{ config?: { logo?: { type?: string; key?: string } } }>;
        };
      };
    };
    const keys = new Set<string>();
    for (const rule of config.config.providerConfigRules.templateRules) {
      const logo = rule.config?.logo;
      if (logo?.type === "builtin" && logo.key) keys.add(logo.key);
    }
    expect(keys.size).toBeGreaterThan(0);
    for (const key of keys) {
      expect(hasBuiltinProviderLogoAsset(key), key).toBe(true);
    }
  });

  it("打包资源加载失败时回退通用图标", () => {
    const { container } = render(
      createElement(ProviderLogo, {
        logo: { type: "builtin", key: "deepseek" },
        className: "size-5",
      }),
    );
    const image = container.querySelector("img");
    expect(image).not.toBeNull();

    fireEvent.error(image!);

    expect(container.querySelector(".lucide-package")).not.toBeNull();
  });
});
