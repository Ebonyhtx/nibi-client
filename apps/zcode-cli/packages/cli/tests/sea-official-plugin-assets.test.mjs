import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { collectSeaOfficialPluginAssets, officialSeaPlugins } from "../scripts/sea-official-plugin-assets.mjs";

test("includes the document judge agent in official SEA assets", async () => {
  const stagingDirectory = await mkdtemp(join(tmpdir(), "zcode-sea-document-agent-"));
  const root = join(import.meta.dirname, "../../..");

  try {
    const { manifest } = await collectSeaOfficialPluginAssets({
      root,
      stagingDirectory,
    });
    assert.equal(
      manifest.plugins.some((plugin) => plugin.name === "document-skills"),
      false,
    );
    for (const [name, skill, version] of [
      ["documents", "docx", "0.2.0"],
      ["pdf", "pdf", "0.2.1"],
      ["presentations", "pptx", "0.2.0"],
      ["spreadsheets", "xlsx", "0.2.0"],
    ]) {
      const plugin = manifest.plugins.find((plugin) => plugin.name === name);
      assert.ok(plugin, `missing ${name} SEA manifest entry`);
      assert.equal(plugin.version, version);
      for (const path of ["agents/visual-judge.md", `skills/${skill}/SKILL.md`])
        assert.ok(
          plugin.files.some((file) => file.path === path),
          `${name}: ${path}`,
        );
    }
    const creator = manifest.plugins.find((plugin) => plugin.name === "plugin-creator");
    assert.ok(creator, "missing plugin-creator SEA manifest entry");
    for (const path of [
      ".nibi-plugin/plugin.json",
      "skills/plugin-creator/SKILL.md",
      "skills/plugin-creator/scripts/create-basic-plugin.mjs",
      "skills/plugin-creator/scripts/marketplace-files.mjs",
      "skills/plugin-creator/scripts/upsert-dev-marketplace.mjs",
      "skills/plugin-creator/scripts/scaffold-files.mjs",
      "skills/plugin-creator/scripts/validate-plugin.mjs",
      "skills/plugin-creator/references/plugin-json-spec.md",
      "skills/plugin-creator/references/installing-and-updating.md",
    ])
      assert.ok(
        creator.files.some((file) => file.path === path),
        `missing ${path}`,
      );
  } finally {
    await rm(stagingDirectory, { force: true, recursive: true });
  }
});

test("rejects an incomplete documents SEA seed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zcode-sea-document-agent-missing-"));
  const root = join(directory, "root");
  const stagingDirectory = join(directory, "staging");

  try {
    // 让 documents 之前的每个插件都齐全，才能把失败点精确定位到 documents 的种子资产。
    const documentsIndex = officialSeaPlugins.findIndex((plugin) => plugin.name === "documents");
    assert.ok(documentsIndex >= 0, "documents must be part of official SEA assets");
    for (const plugin of officialSeaPlugins.slice(0, documentsIndex)) {
      const rootPath = toTestPath(plugin.rootPath);
      await writeTestFile(root, `${rootPath}/.nibi-plugin/plugin.json`, "{}");
      for (const relativePath of plugin.requiredSeedPaths ?? []) {
        await writeTestFile(root, `${rootPath}/${relativePath}`, "x");
      }
    }
    const documents = officialSeaPlugins[documentsIndex];
    await writeTestFile(
      root,
      `${toTestPath(documents.rootPath)}/.nibi-plugin/plugin.json`,
      "{}",
    );

    await assert.rejects(
      collectSeaOfficialPluginAssets({ root, stagingDirectory }),
      /Missing documents required seed asset.*agents[/\\]visual-judge\.md/u,
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

function toTestPath(path) {
  return path.split("\\").join("/");
}

async function writeTestFile(root, relativePath, content) {
  const filePath = join(root, ...relativePath.split("/"));
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}
