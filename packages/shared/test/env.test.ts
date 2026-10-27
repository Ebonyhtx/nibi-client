import { afterEach, describe, expect, it, vi } from "vitest";

async function importFreshEnvModule() {
  vi.resetModules();
  return await import("../src/env.js");
}

describe("shared runtime env", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("构建期可选能力未注入时关闭", async () => {
    const env = await importFreshEnvModule();

    // 单测不注入 ARMS 与自动更新。
    expect(env.NIBI_ARMS_RUM_ENDPOINT).toBe("");
    expect(env.NIBI_AUTO_UPDATE_ENABLED).toBe(false);
  });

  it("未注入 NIBI_ENV 时默认 test 并映射为 local", async () => {
    vi.stubGlobal("__NIBI_ENV__", undefined);

    const env = await importFreshEnvModule();

    expect(env.NIBI_ENV).toBe("test");
    expect(env.normalizeZCodeEnv("development")).toBe("test");
    expect(env.mapZCodeEnvToArmsRumEnv("production")).toBe("local");
  });

  it("未注入身份 define 时 flavor 跟随 NIBI_ENV", async () => {
    vi.stubGlobal("__NIBI_ENV__", "production");
    vi.stubGlobal("__NIBI_PRODUCT_FLAVOR__", undefined);

    const env = await importFreshEnvModule();

    expect(env.NIBI_PRODUCT_FLAVOR).toBe("production");
    expect(env.normalizeZCodeProductFlavor(undefined, "test")).toBe("preview");
    expect(env.normalizeZCodeProductFlavor("bogus", "production")).toBe("production");
  });

  it("显式注入 preview 身份时生产后端构建仍是 Preview", async () => {
    vi.stubGlobal("__NIBI_ENV__", "production");
    vi.stubGlobal("__NIBI_PRODUCT_FLAVOR__", "preview");

    const env = await importFreshEnvModule();

    expect(env.NIBI_ENV).toBe("production");
    expect(env.NIBI_PRODUCT_FLAVOR).toBe("preview");
  });

  it("mapZCodeEnvToArmsRumEnv 将非本地 production 映射为 prod", async () => {
    vi.stubGlobal("__NIBI_ENV__", "production");

    const env = await importFreshEnvModule();

    expect(env.mapZCodeEnvToArmsRumEnv("production")).toBe("prod");
  });

  it("mapZCodeEnvToArmsRumEnv 在本地开发态忽略 production 产品环境并映射为 local", async () => {
    vi.stubGlobal("__NIBI_ENV__", "production");

    const env = await importFreshEnvModule();

    expect(env.mapZCodeEnvToArmsRumEnv("development")).toBe("local");
  });
});
