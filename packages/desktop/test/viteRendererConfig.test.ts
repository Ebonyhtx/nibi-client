import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigFromFile } from "vite";
import { desktopRendererDependencyAliases } from "../vite.config";

describe("desktop renderer Vite dependency aliases", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("points React singleton dependencies to installed package locations", () => {
    for (const dependencyName of ["react", "react-dom", "lucide-react"] as const) {
      expect(
        existsSync(desktopRendererDependencyAliases[dependencyName]),
        `${dependencyName} alias target should exist`,
      ).toBe(true);
    }
  });

  it("keeps React subpath aliases loadable for Vite dependency optimization", () => {
    expect(
      existsSync(resolve(desktopRendererDependencyAliases.react, "jsx-runtime.js")),
      "react/jsx-runtime should resolve from the React package root",
    ).toBe(true);
    expect(
      existsSync(resolve(desktopRendererDependencyAliases["react-dom"], "client.js")),
      "react-dom/client should resolve from the React DOM package root",
    ).toBe(true);
  });

  it("injects our endpoint origin into renderer env, never the upstream one", async () => {
    vi.stubEnv("NIBI_ENV", "test");
    vi.stubEnv("NIBI_BASE_URL", "");
    const desktopRoot = resolve(import.meta.dirname, "..");
    const configFile = resolve(desktopRoot, "vite.config.ts");
    const result = await loadConfigFromFile(
      {
        command: "build",
        mode: "production",
        isPreview: false,
        isSsrBuild: false,
      },
      configFile,
      desktopRoot,
      "silent",
    );

    // 断言**不变量**，不写死某个环境的主机名：写死上游 `zcode.z.ai` 的话，这条用例一边
    // 断言别的产品的端点，一边在 Windows 上因环境差异被 skip 掉（原来就是这样）。
    const define = result?.config.define ?? {};
    const baseUrl = JSON.parse(String(define["import.meta.env.VITE_NIBI_BASE_URL"]));
    const origin = JSON.parse(String(define["import.meta.env.VITE_NIBI_ENDPOINT_ORIGIN"]));

    // 两个键必须同源——它们描述的是同一个 base URL。
    expect(baseUrl).toBe(origin);
    expect(origin).toMatch(/^https:\/\/\S+$/);
    // 绝不回落到上游端点：这是我们自己的基础设施地址。
    expect(origin).not.toMatch(/zcode\.z\.ai|z\.ai/i);
    expect(JSON.parse(String(define.__NIBI_LOCAL_DEVELOPMENT_RUNTIME__))).toBe(false);
  });

  it("marks non-production renderer builds as local development runtime", async () => {
    vi.stubEnv("NIBI_ENV", "production");
    const desktopRoot = resolve(import.meta.dirname, "..");
    const configFile = resolve(desktopRoot, "vite.config.ts");
    const result = await loadConfigFromFile(
      {
        command: "serve",
        mode: "development",
        isPreview: false,
        isSsrBuild: false,
      },
      configFile,
      desktopRoot,
      "silent",
    );

    expect(result?.config.define).toMatchObject({
      __NIBI_ENV__: JSON.stringify("production"),
      __NIBI_PRODUCT_FLAVOR__: JSON.stringify("production"),
      __NIBI_LOCAL_DEVELOPMENT_RUNTIME__: JSON.stringify(true),
      "import.meta.env.VITE_NIBI_E2E_STORE_BRIDGE": JSON.stringify(""),
    });
  });

  it("publishes PDF.js CMaps for non-latin PDF rendering", async () => {
    const desktopRoot = resolve(import.meta.dirname, "..");
    const configFile = resolve(desktopRoot, "vite.config.ts");
    const result = await loadConfigFromFile(
      {
        command: "build",
        mode: "production",
        isPreview: false,
        isSsrBuild: false,
      },
      configFile,
      desktopRoot,
      "silent",
    );

    expect(result?.config.plugins?.some((plugin) => plugin.name === "nibi:pdfjs-cmaps")).toBe(
      true,
    );
  });

  it("injects the E2E store bridge only from the runner flag", async () => {
    vi.stubEnv("NIBI_ENV", "test");
    vi.stubEnv("VITE_NIBI_E2E_STORE_BRIDGE", "1");
    const desktopRoot = resolve(import.meta.dirname, "..");
    const configFile = resolve(desktopRoot, "vite.config.ts");
    const result = await loadConfigFromFile(
      {
        command: "build",
        mode: "production",
        isPreview: false,
        isSsrBuild: false,
      },
      configFile,
      desktopRoot,
      "silent",
    );

    expect(result?.config.define).toMatchObject({
      __NIBI_ENV__: JSON.stringify("test"),
      __NIBI_PRODUCT_FLAVOR__: JSON.stringify("preview"),
      "import.meta.env.VITE_NIBI_E2E_STORE_BRIDGE": JSON.stringify("1"),
    });
  });

  it("NIBI_PREVIEW_IDENTITY=1 让生产后端的 renderer 编译成 Preview 身份", async () => {
    vi.stubEnv("NIBI_ENV", "production");
    vi.stubEnv("NIBI_PREVIEW_IDENTITY", "1");
    const desktopRoot = resolve(import.meta.dirname, "..");
    const configFile = resolve(desktopRoot, "vite.config.ts");
    const result = await loadConfigFromFile(
      {
        command: "build",
        mode: "production",
        isPreview: false,
        isSsrBuild: false,
      },
      configFile,
      desktopRoot,
      "silent",
    );

    expect(result?.config.define).toMatchObject({
      __NIBI_ENV__: JSON.stringify("production"),
      __NIBI_PRODUCT_FLAVOR__: JSON.stringify("preview"),
    });
  });
});
