import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  artifactChangedFiles,
  buildReleaseStatus,
  collectChangedFiles,
  compareVersions,
  evaluateArtifact,
  formatStatusMarkdown,
  formatStatusText,
  latestMarketplaceBaseline,
  loadManifest,
  readLastTag,
  readLedger,
  readPreviousTag,
  recordStage,
  tagVersion,
  validateManifest,
  writeLedger,
} from "../release/core.mjs";
import { checkDesktop, checkNpm, checkSourceServer } from "../release/checks.mjs";
import { checkPluginMarket, checkWebRelease } from "../release/checks-web.mjs";
import {
  buildGithubReleaseBody,
  normalizeReleaseBody,
  validateChangelog,
} from "../release/release-notes-core.mjs";
import { releaseJsonPlugin } from "../../packages/web/vite/remoteFrontendVersion.mjs";

const execFileAsync = promisify(execFile);

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function headResponse(status, size) {
  return new Response(null, {
    status,
    headers: size === undefined ? {} : { "content-length": String(size) },
  });
}

const NPM_ARTIFACT = {
  id: "npm",
  label: "npm",
  paths: [],
  check: {
    kind: "npm",
    packages: [
      "@nibi-studio/cli-linux-x64-gnu",
      "@nibi-studio/cli-linux-arm64-gnu",
      "@nibi-studio/cli-darwin-arm64",
      "@nibi-studio/cli-win32-x64-msvc",
      "@nibi-studio/cli-android-arm64",
    ],
    meta: "@nibi-studio/cli",
  },
};

const SOURCE_ARTIFACT = {
  id: "source-server",
  label: "source",
  paths: [],
  check: {
    kind: "source-server",
    descriptorUrl: "https://dl.example.test/{version}/source-server-release.json",
    targets: ["linux-x64", "linux-arm64"],
  },
};

const DESKTOP_ARTIFACT = {
  id: "desktop",
  label: "desktop",
  paths: [],
  check: {
    kind: "desktop",
    manifestUrl: "https://api.example.test/manifest",
    downloadsUrl: "https://api.example.test/downloads",
    channel: "stable",
    platforms: ["windows-x86_64", "darwin-aarch64", "linux-x86_64"],
  },
};

const WEB_ARTIFACT = {
  id: "web-remote",
  label: "web",
  paths: [],
  check: {
    kind: "web-release",
    surface: "web-remote",
    pageUrl: "https://api.example.test/remote/v4/",
    releaseUrl: "https://api.example.test/remote/v4/release.json",
  },
};

const PLUGIN_ARTIFACT = {
  id: "plugin-market",
  label: "market",
  paths: [],
  verifyAlways: true,
  check: {
    kind: "plugin-market",
    catalogUrl: "https://api.example.test/plugins/marketplace.json",
    plugin: "math-modeling",
  },
};

function npmCatalog(version, options = {}) {
  const packages = {};
  for (const name of [...NPM_ARTIFACT.check.packages, NPM_ARTIFACT.check.meta]) {
    packages[name] = {
      "dist-tags": { latest: options.latest ?? version },
      versions: {
        [version]: {
          dist: {
            integrity: "sha512-abc",
            tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
          },
          ...(name === NPM_ARTIFACT.check.meta
            ? {
                optionalDependencies: Object.fromEntries(
                  NPM_ARTIFACT.check.packages.map((platform) => [
                    platform,
                    options.metaVersion ?? version,
                  ]),
                ),
              }
            : {}),
        },
      },
    };
  }
  return packages;
}

test("release manifest is valid and maps the six release artifacts", async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(
    manifest.artifacts.map((artifact) => artifact.id),
    ["npm", "source-server", "desktop", "web-remote", "web-share", "plugin-market"],
  );
  const source = manifest.artifacts.find((artifact) => artifact.id === "source-server");
  assert.deepEqual(source.check.targets, ["linux-x64", "linux-arm64"]);
  const desktop = manifest.artifacts.find((artifact) => artifact.id === "desktop");
  assert.deepEqual(desktop.check.platforms, ["windows-x86_64", "linux-x86_64"]);
});

test("manifest validation rejects unsafe globs and unknown checks", () => {
  assert.throws(
    () =>
      validateManifest({
        schemaVersion: 1,
        versionSource: "package.json",
        tagPrefix: "v",
        artifacts: [
          {
            id: "x",
            label: "x",
            paths: ["../secret/**"],
            check: { kind: "npm", packages: ["@x/y"], meta: "@x/meta" },
          },
        ],
      }),
    /不能越出仓库/u,
  );
  assert.throws(
    () =>
      validateManifest({
        schemaVersion: 1,
        versionSource: "package.json",
        tagPrefix: "v",
        artifacts: [{ id: "x", label: "x", paths: [], check: { kind: "unknown" } }],
      }),
    /check.kind/u,
  );
});

test("artifactChangedFiles uses POSIX globs and zero-depth **", () => {
  const artifact = { paths: ["packages/web/**", "kernel/Cargo.toml"] };
  assert.deepEqual(
    artifactChangedFiles(artifact, [
      "packages/web/index.html",
      "packages/web/src/a/b.ts",
      "kernel/Cargo.toml",
      "packages/ui/src/x.ts",
    ]),
    ["packages/web/index.html", "packages/web/src/a/b.ts", "kernel/Cargo.toml"],
  );
});

test("git baseline and changed files are read from a real repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "nibi-release-git-"));
  try {
    await execFileAsync("git", ["init", "-q"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "release@example.test"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Release Test"], { cwd: root });
    await writeFile(join(root, "a.txt"), "a\n", "utf8");
    await execFileAsync("git", ["add", "a.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "first"], { cwd: root });
    await execFileAsync("git", ["tag", "v1.0.0"], { cwd: root });
    await writeFile(join(root, "b.txt"), "b\n", "utf8");
    await execFileAsync("git", ["add", "b.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-qm", "second"], { cwd: root });

    assert.equal(await readLastTag(root, "v"), "v1.0.0");
    assert.equal(tagVersion("v", "v1.0.0"), "1.0.0");
    const changed = await collectChangedFiles(root, "v1.0.0");
    assert.deepEqual(changed, ["b.txt"]);

    await execFileAsync("git", ["tag", "v2.0.0"], { cwd: root });
    assert.equal(await readLastTag(root, "v"), "v2.0.0");
    assert.equal(await readPreviousTag(root, "v", "2.0.0"), "v1.0.0");
    assert.deepEqual(await collectChangedFiles(root, "v2.0.0"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ledger records stages and keeps the newest marketplace baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "nibi-release-ledger-"));
  try {
    const ledger = {
      schemaVersion: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      releases: {},
    };
    recordStage(ledger, {
      version: "4.0.2",
      artifactId: "plugin-market",
      stage: "verified",
      revision: 4,
      pluginVersion: "0.12.0",
      at: "2026-01-01T00:00:00.000Z",
    });
    recordStage(ledger, {
      version: "4.1.0",
      artifactId: "npm",
      stage: "built",
      at: "2026-01-02T00:00:00.000Z",
    });
    await writeLedger(root, ledger);
    const loaded = await readLedger(root);
    assert.equal(loaded.releases["4.1.0"].artifacts.npm.built.at, "2026-01-02T00:00:00.000Z");
    assert.deepEqual(latestMarketplaceBaseline(loaded), {
      revision: 4,
      version: "0.12.0",
      appVersion: "4.0.2",
      stage: "verified",
    });
    assert.equal(compareVersions("4.1.0", "4.0.2"), 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("artifact state distinguishes pending, ready, missing and no-op", () => {
  const base = {
    artifact: { check: { kind: "npm" } },
    record: null,
    tagged: false,
  };
  assert.equal(
    evaluateArtifact({
      ...base,
      check: { valid: true, current: true, detail: "ok" },
      required: true,
    }).status,
    "ready",
  );
  assert.equal(
    evaluateArtifact({
      ...base,
      check: { valid: true, current: false, partial: false, detail: "not yet" },
      required: true,
    }).status,
    "pending",
  );
  assert.equal(
    evaluateArtifact({
      ...base,
      check: { valid: true, current: false, partial: false, detail: "not yet" },
      required: true,
      tagged: true,
    }).status,
    "missing",
  );
  assert.equal(
    evaluateArtifact({
      ...base,
      check: { valid: true, current: false, partial: true, detail: "half" },
      required: true,
    }).status,
    "missing",
  );
  assert.equal(
    evaluateArtifact({
      ...base,
      check: { valid: false, current: false, partial: false, detail: "bad" },
      required: true,
    }).status,
    "missing",
  );
  assert.equal(
    evaluateArtifact({
      ...base,
      check: { valid: true, current: false, partial: false, detail: "old" },
      required: false,
    }).status,
    "ready",
  );
});

test("plugin market state is pending when the catalog revision is ahead of the ledger", () => {
  const result = evaluateArtifact({
    artifact: { check: { kind: "plugin-market" } },
    check: {
      valid: true,
      current: false,
      revision: 6,
      pluginVersion: "0.14.0",
      baseline: { revision: 5, version: "0.13.2" },
      detail: "revision 6",
    },
    record: null,
    required: false,
    tagged: false,
  });
  assert.equal(result.status, "pending");
});

test("buildReleaseStatus marks only required artifacts as blocking", () => {
  const manifest = {
    tagPrefix: "v",
    artifacts: [
      { id: "npm", label: "npm", paths: ["kernel/**"], check: { kind: "npm" } },
      {
        id: "plugin-market",
        label: "market",
        paths: [],
        verifyAlways: true,
        check: { kind: "plugin-market" },
      },
    ],
  };
  const status = buildReleaseStatus({
    manifest,
    version: "4.1.0",
    lastTag: "v4.0.2",
    tagged: false,
    changedFiles: ["kernel/src/lib.rs"],
    ledger: { schemaVersion: 1, releases: {} },
    checks: {
      npm: { kind: "npm", valid: true, current: false, partial: false, detail: "0/5" },
      "plugin-market": {
        kind: "plugin-market",
        valid: true,
        current: true,
        revision: 5,
        pluginVersion: "0.13.2",
        baseline: { revision: 5, version: "0.13.2" },
        detail: "revision 5",
      },
    },
  });
  assert.equal(status.artifacts[0].status, "pending");
  assert.equal(status.artifacts[0].required, true);
  assert.equal(status.artifacts[0].blocksVerify, true);
  assert.equal(status.artifacts[1].status, "ready");
  assert.equal(status.artifacts[1].blocksVerify, false);
  assert.equal(status.summary.blocking, 1);
  assert.match(formatStatusText(status), /pending 1 \/ ready 1/u);
  assert.match(formatStatusMarkdown(status), /\| npm \| 1 \| `pending`/u);
});

test("tagged releases use the previous tag as the release scope and warn about post-tag work", () => {
  const status = buildReleaseStatus({
    manifest: {
      tagPrefix: "v",
      artifacts: [{ id: "npm", label: "npm", paths: ["kernel/**"], check: { kind: "npm" } }],
    },
    version: "4.1.0",
    lastTag: "v4.1.0",
    releaseBaselineTag: "v4.0.2",
    tagged: true,
    changedFiles: ["kernel/src/lib.rs"],
    changedAfterTag: ["docs/readme.md"],
    ledger: { schemaVersion: 1, releases: {} },
    checks: {
      npm: { kind: "npm", valid: true, current: false, partial: false, detail: "0/5" },
    },
  });
  assert.equal(status.releaseBaselineTag, "v4.0.2");
  assert.equal(status.changedFiles, 1);
  assert.equal(status.changedAfterTag, 1);
  assert.match(status.warnings.join("\n"), /标签已存在，但之后又有 1 个文件改动/u);
});

test("checkNpm accepts all five packages and rejects a META version mismatch", async () => {
  const version = "4.1.0";
  const catalog = npmCatalog(version);
  const fetchImpl = async (url) => {
    const name = Object.keys(catalog).find((key) => url.includes(key.replace("/", "%2F")));
    return name ? jsonResponse(catalog[name]) : jsonResponse({}, 404);
  };
  const good = await checkNpm(NPM_ARTIFACT, { version, fetchImpl, retries: 0 });
  assert.equal(good.valid, true);
  assert.equal(good.current, true);
  assert.equal(good.present, 6);

  const mismatch = npmCatalog(version, { metaVersion: "4.0.2" });
  const bad = await checkNpm(NPM_ARTIFACT, {
    version,
    fetchImpl: async (url) => {
      const name = Object.keys(mismatch).find((key) => url.includes(key.replace("/", "%2F")));
      return name ? jsonResponse(mismatch[name]) : jsonResponse({}, 404);
    },
    retries: 0,
  });
  assert.equal(bad.valid, false);
  assert.equal(bad.current, false);
});

test("checkNpm reports a missing META package without treating the whole registry as broken", async () => {
  const version = "4.1.0";
  const catalog = npmCatalog(version);
  delete catalog["@nibi-studio/cli"];
  const result = await checkNpm(NPM_ARTIFACT, {
    version,
    fetchImpl: async (url) => {
      const name = Object.keys(catalog).find((key) => url.includes(key.replace("/", "%2F")));
      return name ? jsonResponse(catalog[name]) : jsonResponse({}, 404);
    },
    retries: 0,
  });
  assert.equal(result.valid, true);
  assert.equal(result.current, false);
  assert.equal(result.present, 5);
  assert.match(result.detail, /5\/6/u);
});

function sourceDescriptor(version) {
  return {
    schemaVersion: 1,
    version,
    archives: SOURCE_ARTIFACT.check.targets.map((target, index) => ({
      target,
      version,
      fileName: `nibi-server-${target}.tar.gz`,
      sha256: "a".repeat(64),
      sizeBytes: 100 + index,
      urls: [`nibi-server-${target}.tar.gz`],
    })),
  };
}

test("checkSourceServer requires descriptor and all configured archives", async () => {
  const version = "4.1.0";
  const descriptor = sourceDescriptor(version);
  let descriptorServed = true;
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("source-server-release.json")) {
      return descriptorServed ? jsonResponse(descriptor) : jsonResponse({}, 404);
    }
    const target = descriptor.archives.find((archive) => url.endsWith(archive.fileName))?.target;
    if (!target || target === "linux-arm64") return jsonResponse({}, 404);
    if (options.method === "HEAD")
      return headResponse(200, descriptor.archives.find((a) => a.target === target).sizeBytes);
    return jsonResponse({}, 500);
  };
  const partial = await checkSourceServer(SOURCE_ARTIFACT, {
    version,
    fetchImpl,
    retries: 0,
  });
  assert.equal(partial.valid, true);
  assert.equal(partial.current, false);
  assert.equal(partial.present, 1);
  assert.equal(partial.partial, true);

  descriptorServed = false;
  const absent = await checkSourceServer(SOURCE_ARTIFACT, {
    version,
    fetchImpl,
    retries: 0,
  });
  assert.equal(absent.valid, true);
  assert.equal(absent.current, false);
  assert.match(absent.detail, /404/u);
});

test("checkDesktop requires both update manifest and download inventory per platform", async () => {
  const version = "4.1.0";
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (parsed.hostname === "dl.example.test") {
      return headResponse(200, 1);
    }
    const platform = parsed.searchParams.get("platform");
    const isDownloads = parsed.pathname.endsWith("/downloads");
    if (!platform) return jsonResponse({}, 400);
    if (isDownloads && platform === "linux-x86_64") return jsonResponse({}, 404);
    return jsonResponse(
      isDownloads
        ? {
            version,
            downloads: [{ kind: "installer", name: "NIBI", url: "https://dl.example.test/app" }],
          }
        : {
            version,
            files: [{ url: "https://dl.example.test/app", sha512: "abc", size: 1 }],
          },
    );
  };
  const result = await checkDesktop(DESKTOP_ARTIFACT, {
    version,
    fetchImpl,
    retries: 0,
  });
  assert.equal(result.valid, true);
  assert.equal(result.current, false);
  assert.equal(result.present, 2);
  assert.equal(result.partial, true);
  assert.match(result.detail, /2\/3/u);
});

test("checkWebRelease reads no-cache page meta before the cached release.json", async () => {
  const version = "4.1.0";
  const page = (metaVersion, surface = "web-remote") =>
    new Response(
      `<!doctype html><html><head>
        <meta name="nibi-release-version" content="${metaVersion}">
        <meta name="nibi-release-surface" content="${surface}">
      </head></html>`,
      { status: 200, headers: { "content-type": "text/html" } },
    );

  const current = await checkWebRelease(WEB_ARTIFACT, {
    version,
    fetchImpl: async () => page(version),
    retries: 0,
  });
  assert.equal(current.valid, true);
  assert.equal(current.current, true);
  assert.equal(current.detail, "页面 4.1.0");

  const old = await checkWebRelease(WEB_ARTIFACT, {
    version,
    fetchImpl: async () => page("4.0.2"),
    retries: 0,
  });
  assert.equal(old.valid, true);
  assert.equal(old.current, false);
  assert.equal(old.detail, "页面 4.0.2");

  const unmarked = await checkWebRelease(WEB_ARTIFACT, {
    version,
    fetchImpl: async () =>
      new Response("<!doctype html><html><head></head></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    retries: 0,
  });
  assert.equal(unmarked.valid, true);
  assert.equal(unmarked.current, false);
  assert.match(unmarked.detail, /缺少 nibi-release meta/u);
});

test("checkWebRelease falls back to release.json only when the page is absent", async () => {
  const version = "4.1.0";
  const fetchImpl = async (url) => {
    if (url.endsWith("release.json")) {
      return jsonResponse({
        schemaVersion: 1,
        surface: "web-remote",
        version,
        environment: "production",
      });
    }
    return jsonResponse({}, 404);
  };
  const result = await checkWebRelease(WEB_ARTIFACT, { version, fetchImpl, retries: 0 });
  assert.equal(result.valid, true);
  assert.equal(result.current, true);
  assert.equal(result.detail, "release.json 4.1.0");
});

test("checkWebRelease rejects a page whose asset base was rewritten to a local path", async () => {
  const page = `<!doctype html><html><head>
      <meta name="nibi-release-version" content="4.1.1">
      <meta name="nibi-release-surface" content="web-remote">
    </head><body>
      <script type="module" src="/Program Files/Git/remote/v4/assets/index-x.js"></script>
    </body></html>`;
  const result = await checkWebRelease(WEB_ARTIFACT, {
    version: "4.1.1",
    fetchImpl: async () =>
      new Response(page, { status: 200, headers: { "content-type": "text/html" } }),
    retries: 0,
  });
  assert.equal(result.valid, false);
  assert.match(result.detail, /本机路径/u);
});

test("checkWebRelease verifies the entry script is actually served", async () => {
  const page = `<!doctype html><html><head>
      <meta name="nibi-release-version" content="4.1.1">
      <meta name="nibi-release-surface" content="web-remote">
    </head><body>
      <script type="module" src="/remote/v4/assets/index-x.js"></script>
    </body></html>`;
  const fetchImpl = async (url) => {
    if (url.endsWith("index-x.js")) return new Response("export {};", { status: 200 });
    return new Response(page, { status: 200, headers: { "content-type": "text/html" } });
  };
  const ok = await checkWebRelease(WEB_ARTIFACT, {
    version: "4.1.1",
    fetchImpl,
    retries: 0,
  });
  assert.equal(ok.valid, true);
  assert.equal(ok.current, true);

  const missing = await checkWebRelease(WEB_ARTIFACT, {
    version: "4.1.1",
    fetchImpl: async (url) =>
      url.endsWith("index-x.js")
        ? new Response("missing", { status: 404 })
        : new Response(page, { status: 200, headers: { "content-type": "text/html" } }),
    retries: 0,
  });
  assert.equal(missing.valid, false);
  assert.match(missing.detail, /入口脚本 HTTP 404/u);
});

test("checkPluginMarket validates catalog, zip hash and ledger revision", async () => {
  const version = "4.1.0";
  const catalog = {
    name: "nibi-official",
    revision: 5,
    plugins: [
      {
        name: "math-modeling",
        version: "0.13.2",
        source: {
          type: "zip",
          url: "https://api.example.test/plugins/math-modeling/download",
          sha256: "b".repeat(64),
        },
      },
    ],
  };
  const fetchImpl = async (url, options = {}) => {
    if (url.endsWith("marketplace.json")) return jsonResponse(catalog);
    if (options.method === "HEAD") return headResponse(401);
    return jsonResponse({}, 404);
  };
  const result = await checkPluginMarket(PLUGIN_ARTIFACT, {
    version,
    fetchImpl,
    retries: 0,
    baseline: { revision: 5, version: "0.13.2" },
  });
  assert.equal(result.valid, true);
  assert.equal(result.current, true);
  assert.equal(result.revision, 5);
  assert.match(result.detail, /付费门禁/u);

  const ahead = await checkPluginMarket(PLUGIN_ARTIFACT, {
    version,
    fetchImpl,
    retries: 0,
    baseline: { revision: 4, version: "0.12.0" },
  });
  assert.equal(ahead.current, false);
  assert.equal(ahead.partial, true);
});

test("releaseJsonPlugin emits a stable release marker asset and page meta", () => {
  const plugin = releaseJsonPlugin({
    surface: "web-share",
    version: "4.1.0",
    environment: "production",
    commit: "abc123",
  });
  const tags = plugin.transformIndexHtml();
  assert.deepEqual(
    tags.map((tag) => [tag.attrs.name, tag.attrs.content]),
    [
      ["nibi-release-version", "4.1.0"],
      ["nibi-release-surface", "web-share"],
      ["nibi-release-commit", "abc123"],
    ],
  );
  let emitted;
  plugin.generateBundle.call({ emitFile: (file) => (emitted = file) });
  assert.equal(emitted.fileName, "release.json");
  assert.deepEqual(JSON.parse(emitted.source), {
    schemaVersion: 1,
    surface: "web-share",
    version: "4.1.0",
    environment: "production",
    commit: "abc123",
  });
});

// ————————————————————————————————————————————————————————————————
// 发布说明口径（scripts/release/release-notes-core.mjs）
// ————————————————————————————————————————————————————————————————

const GOOD_NOTES = `# 更新日志

## [4.1.1] - 2026-11-17

反馈中心与远端连接的一次集中修复。

### 新功能

- 反馈中心全新改版：附件上传更快，图片会自动压缩。
- 反馈草稿自动保存，关闭窗口或切换页面后不会丢失。

### 问题修复

- 修复部分环境连接远端设备时提示“远端资源下载源未配置”的问题。

### 变更

- 没有可用模型时直接提示配置模型。
`;

test("release notes: user-facing entry passes and round-trips to the GitHub body", () => {
  const { entries, violations } = validateChangelog(GOOD_NOTES, { currentVersion: "4.1.1" });
  assert.deepEqual(violations, []);
  const body = buildGithubReleaseBody(entries[0]);
  assert.match(body, /^反馈中心与远端连接的一次集中修复。/u);
  assert.match(body, /### 新功能\n\n- 反馈中心全新改版/u);
  assert.match(body, /## 下载[\s\S]*https:\/\/nibistudio\.cn/u);
  assert.equal(normalizeReleaseBody(body), normalizeReleaseBody(`${body}\n\n`));
});

test("release notes: engineering and security details are rejected", () => {
  const text = GOOD_NOTES.replace(
    "- 反馈草稿自动保存，关闭窗口或切换页面后不会丢失。",
    "- 草稿改由 Rust 内核落盘，修复 localStorage 写入失败。",
  ).replace(
    "- 没有可用模型时直接提示配置模型。",
    "- 修复一个越权访问漏洞（CVE-2026-0001）。",
  );
  const { violations } = validateChangelog(text, { currentVersion: "4.1.1" });
  assert.ok(violations.some((item) => item.includes("rust")));
  assert.ok(violations.some((item) => item.includes("内核")));
  assert.ok(violations.some((item) => item.includes("漏洞")));
  assert.ok(violations.some((item) => item.includes("CVE-2026-0001") || item.includes("cve")));
});

test("release notes: fixed section order and current version at top", () => {
  const reordered = GOOD_NOTES.replace("### 新功能", "### 变更").replace(
    "### 问题修复",
    "### 新功能",
  );
  const orderViolations = validateChangelog(reordered, { currentVersion: "4.1.1" }).violations;
  assert.ok(orderViolations.some((item) => item.includes("顺序")));

  const stale = validateChangelog(GOOD_NOTES, { currentVersion: "4.2.0" }).violations;
  assert.ok(stale.some((item) => item.includes("顶部条目是 4.1.1")));
});

test("release notes: allowed product commands do not trip the term list", () => {
  const text = GOOD_NOTES.replace(
    "- 没有可用模型时直接提示配置模型。",
    "- 新增 `npm install -g @nibi-studio/cli` 安装方式。",
  );
  assert.deepEqual(validateChangelog(text, { currentVersion: "4.1.1" }).violations, []);
});
