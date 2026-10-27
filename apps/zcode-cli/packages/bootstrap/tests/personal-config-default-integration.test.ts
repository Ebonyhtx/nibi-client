import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createSharedZCodeCredentialStore } from "@nibi/adapters/auth";
import { NodePersonalProviderConfigRepository } from "@nibi/provider-node";
import { ProviderConfig } from "@nibi/provider";
import { configureCodingPlanApiKey } from "../src/auth-login.js";

// 旧版 config.json 的一次性导入（含「Standalone 首次导入」两条用例）已随 4.0 分家删除：
// NIBI 没有需要迁移的历史数据，个人 provider 配置只认 provider_config.json。
// 这里只保留与「同一份 Personal 文件、登录不覆盖既有 Provider」有关的回归。

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Todo104 CLI 同文件默认选择", () => {
  // 上游「Coding Plan 登录」依赖 Built-in Config 里的 individual-coding-plan Provider，
  // 而 NIBI 4.0 已删除全部套餐 Provider。CLI 的 /login 命令因此没有可用的后端契约，
  // 保留 skip 作为待产品决策的记录（要么删掉 CLI 登录，要么给它自己的端点）。
  it.skip("登录沿用注入的 Personal 路径，更新默认选择不覆盖 Provider 内容", async () => {
    const directory = await mkdtemp(join(tmpdir(), "todo104-cli-login-"));
    directories.push(directory);
    const personalPath = join(directory, "injected-personal.json");
    const env = {
      NIBI_CREDENTIAL_SECRET: "todo104-fixture-only",
      NIBI_PERSONAL_PROVIDER_CONFIG_FILE: personalPath,
      NIBI_BUILTIN_PROVIDER_CONFIG_FILE: fileURLToPath(
        new URL("../../../../../config/provider/nibi-builtin.json", import.meta.url),
      ),
    };
    const repository = new NodePersonalProviderConfigRepository({
      filePath: personalPath,
      pollingIntervalMs: false,
    });
    try {
      await repository.update((current) => ({
        ...current,
        providers: current.providers.setRule({
          providerId: "custom",
          providerName: "Keep Me",
          config: new ProviderConfig({ personalModelIds: ["model-a"] }),
        }),
      }));
      const credentialStore = createSharedZCodeCredentialStore({
        baseDir: join(directory, "credentials"),
        env,
      });
      const result = await configureCodingPlanApiKey({
        apiKey: "fixture-key",
        providerId: "bigmodel",
        credentialStore,
        env,
      });
      expect(result.configPath).toBe(personalPath);
      const stored = await repository.read();
      expect(stored.defaultModelSelection?.providerId).toBe(
        "account:bigmodel-individual-coding-plan",
      );
      expect(stored.providers.getRule("custom")?.providerName).toBe("Keep Me");
      expect(stored.providers.get("custom")?.personalModelIds).toEqual(["model-a"]);
    } finally {
      repository.dispose();
    }
  });
});
