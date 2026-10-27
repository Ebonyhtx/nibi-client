import {
  ModelConfigRules,
  ProviderConfigMap,
  type ProviderConfigLayerUpdate,
} from "@nibi/provider";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  NodeModelSelectionConfigRepository,
  NodePersonalProviderConfigRepository,
} from "../src/index.js";

const roots: string[] = [];
const owners: NodePersonalProviderConfigRepository[] = [];
// Windows 无开发者模式时创建 symlink 会 EPERM；symlink 主题用例按能力探测跳过
const canCreateSymlink = await (async () => {
  const probeRoot = await mkdtemp(join(tmpdir(), "zcode-symlink-probe-"));
  try {
    await symlink(probeRoot, join(probeRoot, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    await rm(probeRoot, { force: true, recursive: true });
  }
})();
function selectionRepository(filePath: string) {
  const personalRepository = new NodePersonalProviderConfigRepository({
    filePath,
    pollingIntervalMs: false,
  });
  owners.push(personalRepository);
  return new NodeModelSelectionConfigRepository({ personalRepository });
}

afterEach(async () => {
  owners.splice(0).forEach((owner) => owner.dispose());
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("NodeModelSelectionConfigRepository", () => {

  it("损坏 Personal 读取降级但保留原文件，禁止默认保存覆盖它", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-model-selection-config-"));
    roots.push(root);
    const filePath = join(root, "provider_config.json");
    await writeFile(filePath, "{not-json", "utf8");
    const repository = selectionRepository(filePath);

    await expect(repository.read()).resolves.toBeUndefined();
    await expect(
      repository.saveConfiguredDefault({ providerId: "p", modelId: "m" }),
    ).rejects.toThrow();
    await expect(readFile(filePath, "utf8")).resolves.toBe("{not-json");
    repository.dispose();
  });

  (canCreateSymlink ? it : it.skip)(
    "does not delete the target when reading fails before content can be decoded",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-model-selection-config-"));
      roots.push(root);
      const directory = join(root, "configured-default-directory");
      const filePath = join(root, "provider_config.json");
      await mkdir(directory);
      await symlink(directory, filePath, "dir");
      const repository = selectionRepository(filePath);

      await expect(repository.read()).resolves.toBeUndefined();
      expect((await lstat(filePath)).isSymbolicLink()).toBe(true);
      repository.dispose();
    },
  );
});
