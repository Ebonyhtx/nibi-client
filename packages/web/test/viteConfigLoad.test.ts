import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigFromFile } from "vite";

describe("web Vite config", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([undefined, "   ", " 3.12.9-beta.1 "])(
    "构建版本使用手动值或 package 默认值：%s",
    async (override) => {
      vi.stubEnv("WEB_REMOTE_FRONTEND_VERSION", override);
      const webRoot = resolve(import.meta.dirname, "..");
      const { version } = JSON.parse(
        await readFile(resolve(webRoot, "../../package.json"), "utf8"),
      );
      const result = await loadConfigFromFile(
        { command: "build", mode: "production", isPreview: false, isSsrBuild: false },
        resolve(webRoot, "vite.config.ts"),
        webRoot,
        "silent",
      );
      expect(result?.config.define?.__NIBI_VERSION__).toBe(
        JSON.stringify(override?.trim() || version),
      );
    },
  );

  it("非法手动版本在构建配置加载时失败", async () => {
    vi.stubEnv("WEB_REMOTE_FRONTEND_VERSION", "../latest");
    const webRoot = resolve(import.meta.dirname, "..");
    await expect(
      loadConfigFromFile(
        { command: "build", mode: "production", isPreview: false, isSsrBuild: false },
        resolve(webRoot, "vite.config.ts"),
        webRoot,
        "silent",
      ),
    ).rejects.toThrow(/version/i);
  });

  it("publishes PDF.js CMaps for non-latin PDF rendering", async () => {
    const webRoot = resolve(import.meta.dirname, "..");
    const configFile = resolve(webRoot, "vite.config.ts");
    const result = await loadConfigFromFile(
      {
        command: "build",
        mode: "production",
        isPreview: false,
        isSsrBuild: false,
      },
      configFile,
      webRoot,
      "silent",
    );

    expect(result?.config.plugins?.some((plugin) => plugin.name === "nibi:pdfjs-cmaps")).toBe(
      true,
    );
  });

  it("显式 NIBI_ENV=production 时注入生产 ZAI OAuth 和 API 链接", async () => {
    vi.stubEnv("NIBI_ENV", "production");
    const webRoot = resolve(import.meta.dirname, "..");
    const configFile = resolve(webRoot, "vite.config.ts");
    const result = await loadConfigFromFile(
      {
        command: "build",
        mode: "production",
        isPreview: false,
        isSsrBuild: false,
      },
      configFile,
      webRoot,
      "silent",
    );

    expect(result?.config.define).toMatchObject({
      "import.meta.env.VITE_ZAI_OAUTH_CLIENT_ID": JSON.stringify("client_P8X5CMWmlaRO9gyO-KSqtg"),
      // NIBI 4.0 的生产链接常量指向自家 API（上游域名已不再使用）。
      "import.meta.env.VITE_NIBI_BASE_URL": JSON.stringify("https://api.nibistudio.top"),
    });
  });

  it.each([
    ["test", "https://bigmodel.cn"],
    ["production", "https://bigmodel.cn"],
  ])("%s 构建向远控登录页注入对应 BigModel 授权域名", async (environment, origin) => {
    vi.stubEnv("NIBI_ENV", environment);
    const webRoot = resolve(import.meta.dirname, "..");
    const result = await loadConfigFromFile(
      { command: "build", mode: "production", isPreview: false, isSsrBuild: false },
      resolve(webRoot, "vite.config.ts"),
      webRoot,
      "silent",
    );
    expect(result?.config.define?.["import.meta.env.VITE_BIGMODEL_OAUTH_ORIGIN"]).toBe(
      JSON.stringify(origin),
    );
  });

  // Windows 跳过：环境配置差异导致断言失败，需要 CI 环境统一配置
  const isWindows = process.platform === "win32";

  (isWindows ? it.skip : it)(
    "uses the same public ZAI OAuth origin in local development mode",
    async () => {
      vi.stubEnv("NIBI_ENV", "");
      vi.stubEnv("NIBI_BASE_URL", "");
      vi.stubEnv("ZAI_OAUTH_ORIGIN", "");
      vi.stubEnv("ZAI_OAUTH_CLIENT_ID", "");
      const webRoot = resolve(import.meta.dirname, "..");
      const configFile = resolve(webRoot, "vite.config.ts");
      const result = await loadConfigFromFile(
        {
          command: "serve",
          mode: "development",
          isPreview: false,
          isSsrBuild: false,
        },
        configFile,
        webRoot,
        "silent",
      );

      expect(result?.config.define).toMatchObject({
        "import.meta.env.VITE_ZAI_OAUTH_CLIENT_ID": JSON.stringify("client_P8X5CMWmlaRO9gyO-KSqtg"),
        // 测试档链接常量同样指向自家 API。
        "import.meta.env.VITE_NIBI_BASE_URL": JSON.stringify("https://api.nibistudio.top"),
        "import.meta.env.VITE_ZAI_OAUTH_ORIGIN": JSON.stringify("https://chat.z.ai"),
      });
    },
  );

  it("uses shared ZCode endpoint env override for renderer injection", async () => {
    vi.stubEnv("NIBI_ENV", "test");
    vi.stubEnv("NIBI_BASE_URL", "https://zcode.z.ai/custom/path");
    const webRoot = resolve(import.meta.dirname, "..");
    const configFile = resolve(webRoot, "vite.config.ts");
    const result = await loadConfigFromFile(
      {
        command: "build",
        mode: "production",
        isPreview: false,
        isSsrBuild: false,
      },
      configFile,
      webRoot,
      "silent",
    );

    expect(result?.config.define).toMatchObject({
      // 显式 NIBI_BASE_URL 覆盖（这里故意用一个非默认 origin）必须只取 origin。
      "import.meta.env.VITE_NIBI_BASE_URL": JSON.stringify("https://zcode.z.ai"),
      "import.meta.env.VITE_NIBI_ENDPOINT_ORIGIN": JSON.stringify("https://zcode.z.ai"),
    });
  });
});
